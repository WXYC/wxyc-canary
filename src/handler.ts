import { CloudWatchClient, PutMetricDataCommand, StandardUnit, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { checks, signInDj } from './checks.js';
import { reportOutcomesToGitHub } from './github-issues.js';
import type { CanaryConfig, CheckContext, CheckOutcome, CheckResult } from './types.js';

const METRIC_NAMESPACE = 'WXYC/Canary';
const DEFAULT_ENRICHMENT_POLL_TIMEOUT_MS = 45_000;
const DEFAULT_ENRICHMENT_POLL_INTERVAL_MS = 2_000;

function loadConfigFromEnv(): CanaryConfig {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`required env var ${key} is unset`);
    return v;
  };
  return {
    backendUrl: required('CANARY_BACKEND_URL'),
    authUrl: required('CANARY_AUTH_URL'),
    semanticIndexUrl: required('CANARY_SEMANTIC_INDEX_URL'),
    originUrl: process.env.CANARY_ORIGIN_URL ?? 'https://dj.wxyc.org',
    djEmail: process.env.CANARY_DJ_EMAIL,
    djPassword: process.env.CANARY_DJ_PASSWORD,
    timeoutMs: process.env.CANARY_TIMEOUT_MS ? Number(process.env.CANARY_TIMEOUT_MS) : 8000,
    awsRegion: process.env.AWS_REGION ?? 'us-east-1',
    publishMetrics: process.env.CANARY_PUBLISH_METRICS !== 'false',
    enableWriteProbe: process.env.CANARY_ENABLE_WRITE_PROBE === 'true',
    enrichmentPollTimeoutMs: process.env.CANARY_ENRICHMENT_POLL_TIMEOUT_MS
      ? Number(process.env.CANARY_ENRICHMENT_POLL_TIMEOUT_MS)
      : undefined,
    enrichmentPollIntervalMs: process.env.CANARY_ENRICHMENT_POLL_INTERVAL_MS
      ? Number(process.env.CANARY_ENRICHMENT_POLL_INTERVAL_MS)
      : undefined,
  };
}

/**
 * Resolve DJ credentials from one of two sources, in order:
 *   1. `CANARY_DJ_EMAIL` + `CANARY_DJ_PASSWORD` env vars (local + tests).
 *   2. `CANARY_DJ_SECRET_ARN` pointing at a Secrets Manager secret with a
 *      JSON value of shape `{"email": "...", "password": "..."}` (prod).
 * Returns undefined when neither is configured — DJ-auth checks downgrade
 * to skipped in that case.
 */
async function resolveDjCredentials(config: CanaryConfig): Promise<{ email: string; password: string } | undefined> {
  if (config.djEmail && config.djPassword) {
    return { email: config.djEmail, password: config.djPassword };
  }
  const secretArn = process.env.CANARY_DJ_SECRET_ARN;
  if (!secretArn) return undefined;

  const sm = new SecretsManagerClient({ region: config.awsRegion ?? 'us-east-1' });
  const result = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error(`secret ${secretArn} has no SecretString`);
  }
  const parsed = JSON.parse(result.SecretString) as { email?: string; password?: string };
  if (!parsed.email || !parsed.password) {
    throw new Error(`secret ${secretArn} JSON missing required keys email/password`);
  }
  return { email: parsed.email, password: parsed.password };
}

/**
 * Run every check, regardless of individual failures. Returns one outcome
 * per check. DJ-auth checks downgrade to 'skipped' when no DJ credentials
 * are configured — distinct from 'fail' so the alarm only fires on real
 * regressions, not on operator-caused gaps. Write-canary checks also
 * downgrade to 'skipped' when `enableWriteProbe=false` (the default).
 */
export async function runCanary(config: CanaryConfig): Promise<CheckOutcome[]> {
  let djCreds: { email: string; password: string } | undefined;
  let djAuthError: string | undefined;
  try {
    djCreds = await resolveDjCredentials(config);
  } catch (err) {
    djAuthError = `credential resolution failed: ${(err as Error).message}`;
  }

  let djBearerToken: string | undefined;
  let djUserId: string | undefined;
  if (djCreds) {
    try {
      const signIn = await signInDj(
        config.authUrl,
        djCreds.email,
        djCreds.password,
        config.originUrl ?? 'https://dj.wxyc.org'
      );
      djBearerToken = signIn.jwt;
      djUserId = signIn.userId;
    } catch (err) {
      djAuthError = (err as Error).message;
      // Don't throw — let the DJ-auth checks individually fail with the auth
      // error so each one shows up in the per-check metric. Catching it
      // here would mask a partial outage where auth is down but anonymous
      // reads still work.
    }
  }

  const ctx: CheckContext = {
    backendUrl: config.backendUrl,
    authUrl: config.authUrl,
    semanticIndexUrl: config.semanticIndexUrl,
    djBearerToken,
    djUserId,
    enrichmentPollTimeoutMs: config.enrichmentPollTimeoutMs ?? DEFAULT_ENRICHMENT_POLL_TIMEOUT_MS,
    enrichmentPollIntervalMs: config.enrichmentPollIntervalMs ?? DEFAULT_ENRICHMENT_POLL_INTERVAL_MS,
  };

  const outcomes = await Promise.all(
    checks.map(async (check): Promise<CheckOutcome> => {
      if (check.requiresAuth && !djCreds && !djAuthError) {
        return { name: check.name, status: 'skipped', latencyMs: 0, message: 'no DJ credentials configured' };
      }
      if (check.requiresAuth && djAuthError) {
        return { name: check.name, status: 'fail', latencyMs: 0, message: `auth precondition failed: ${djAuthError}` };
      }
      if (check.writes && !config.enableWriteProbe) {
        return {
          name: check.name,
          status: 'skipped',
          latencyMs: 0,
          message: 'write probe disabled (CANARY_ENABLE_WRITE_PROBE)',
        };
      }

      const startedAt = performance.now();
      try {
        const result: void | CheckResult = await check.run(ctx);
        const latencyMs = Math.round(performance.now() - startedAt);
        if (result && result.skipped) {
          return {
            name: check.name,
            status: 'skipped',
            latencyMs,
            message: result.skipReason ?? 'check skipped',
          };
        }
        return {
          name: check.name,
          status: 'pass',
          latencyMs,
          metrics: result?.metrics,
        };
      } catch (err) {
        return {
          name: check.name,
          status: 'fail',
          latencyMs: Math.round(performance.now() - startedAt),
          message: (err as Error).message,
        };
      }
    })
  );

  return outcomes;
}

/**
 * Infer a CloudWatch unit from the metric name suffix. Keep this in lock-step
 * with the convention documented on `CheckResult.metrics` in `types.ts` —
 * callers name metrics expecting a specific unit, and silently defaulting to
 * Count would render dashboards meaningless.
 */
function unitForMetric(metricName: string): StandardUnit {
  if (metricName.endsWith('Seconds')) return StandardUnit.Seconds;
  if (metricName.endsWith('Milliseconds')) return StandardUnit.Milliseconds;
  return StandardUnit.Count;
}

/**
 * Publish per-check failure, skip, latency, and any custom metrics in one
 * PutMetricData call. `CheckFailure` is emitted twice (dimensioned +
 * dimensionless) per the wxyc-canary#13 convention. Custom check metrics
 * (`outcome.metrics`) follow the same pattern: emitted once with the
 * `Check` dimension and once dimensionless, so a plain-form alarm can
 * target the dimensionless series without a SUM(SEARCH(...)) expression.
 * Failures stay non-fatal so the Lambda still exits on the outcome list,
 * not on a CloudWatch hiccup.
 */
async function publishMetrics(outcomes: CheckOutcome[], region: string): Promise<void> {
  const client = new CloudWatchClient({ region });
  const timestamp = new Date();
  const metricData = outcomes.flatMap((o) => {
    const failureValue = o.status === 'fail' ? 1 : 0;
    const base: MetricDatum[] = [
      {
        MetricName: 'CheckFailure',
        Value: failureValue,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
        Dimensions: [{ Name: 'Check', Value: o.name }],
      },
      {
        MetricName: 'CheckFailure',
        Value: failureValue,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
        Dimensions: [],
      },
      {
        MetricName: 'CheckSkipped',
        Value: o.status === 'skipped' ? 1 : 0,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
        Dimensions: [{ Name: 'Check', Value: o.name }],
      },
      {
        MetricName: 'CheckLatency',
        Value: o.latencyMs,
        Unit: StandardUnit.Milliseconds,
        Timestamp: timestamp,
        Dimensions: [{ Name: 'Check', Value: o.name }],
      },
    ];
    if (o.metrics) {
      for (const [name, value] of Object.entries(o.metrics)) {
        const unit = unitForMetric(name);
        base.push(
          {
            MetricName: name,
            Value: value,
            Unit: unit,
            Timestamp: timestamp,
            Dimensions: [{ Name: 'Check', Value: o.name }],
          },
          {
            MetricName: name,
            Value: value,
            Unit: unit,
            Timestamp: timestamp,
            Dimensions: [],
          }
        );
      }
    }
    return base;
  });
  await client.send(new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: metricData }));
}

/**
 * Lambda entry. Exits non-zero (via thrown error) if any check failed, so
 * CloudWatch's built-in `Errors` metric on the Lambda function lights up
 * even before the custom metrics arrive. The CloudFormation alarm fires
 * on the per-check `CheckFailure` metric since that names *which* surface
 * is broken.
 */
export const handler = async (): Promise<{ outcomes: CheckOutcome[]; failed: number; skipped: number }> => {
  const config = loadConfigFromEnv();
  const outcomes = await runCanary(config);

  if (config.publishMetrics) {
    try {
      await publishMetrics(outcomes, config.awsRegion ?? 'us-east-1');
    } catch (err) {
      console.error('failed to publish CloudWatch metrics', err);
    }
  }

  // Mirror outcomes into GitHub issues for morning triage when configured.
  // Same non-fatal contract as publishMetrics: a GitHub outage must not
  // mask the canary's primary signal (the throw on failed checks).
  const ghParamName = process.env.CANARY_GITHUB_TOKEN_SSM_PARAM;
  const ghRepo = process.env.CANARY_GITHUB_ISSUES_REPO;
  if (ghParamName && ghRepo) {
    try {
      const ssm = new SSMClient({ region: config.awsRegion ?? 'us-east-1' });
      const param = await ssm.send(new GetParameterCommand({ Name: ghParamName, WithDecryption: true }));
      const token = param.Parameter?.Value;
      if (!token) throw new Error(`SSM parameter ${ghParamName} has no Value`);
      await reportOutcomesToGitHub(outcomes, { token, repo: ghRepo });
    } catch (err) {
      console.error('failed to report outcomes to GitHub', err);
    }
  }

  const failed = outcomes.filter((o) => o.status === 'fail').length;
  const skipped = outcomes.filter((o) => o.status === 'skipped').length;
  console.log(JSON.stringify({ outcomes, failed, skipped }));

  if (failed > 0) {
    const failures = outcomes.filter((o) => o.status === 'fail').map((o) => `${o.name}: ${o.message}`);
    throw new Error(`canary failed (${failed}/${outcomes.length} checks): ${failures.join('; ')}`);
  }

  return { outcomes, failed, skipped };
};

if (process.env.CANARY_LOCAL === 'true') {
  handler()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
