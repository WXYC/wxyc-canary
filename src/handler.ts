import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { checks, signInDj } from './checks.js';
import type { CanaryConfig, CheckContext, CheckOutcome } from './types.js';

const METRIC_NAMESPACE = 'WXYC/Canary';

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
 * regressions, not on operator-caused gaps.
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
  if (djCreds) {
    try {
      djBearerToken = await signInDj(
        config.authUrl,
        djCreds.email,
        djCreds.password,
        config.originUrl ?? 'https://dj.wxyc.org'
      );
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
  };

  const outcomes = await Promise.all(
    checks.map(async (check): Promise<CheckOutcome> => {
      if (check.requiresAuth && !djCreds && !djAuthError) {
        return { name: check.name, status: 'skipped', latencyMs: 0, message: 'no DJ credentials configured' };
      }
      if (check.requiresAuth && djAuthError) {
        return { name: check.name, status: 'fail', latencyMs: 0, message: `auth precondition failed: ${djAuthError}` };
      }

      const startedAt = performance.now();
      try {
        await check.run(ctx);
        return { name: check.name, status: 'pass', latencyMs: Math.round(performance.now() - startedAt) };
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
 * Publish per-check failure (0 or 1) and latency metrics to CloudWatch.
 * One PutMetricData call carries all checks; CloudWatch dedupes by
 * (namespace, metric, dimensions). Failures stay non-fatal here so the
 * Lambda still exits with the right code based on the outcome list.
 */
async function publishMetrics(outcomes: CheckOutcome[], region: string): Promise<void> {
  const client = new CloudWatchClient({ region });
  const timestamp = new Date();
  const metricData = outcomes.flatMap((o) => [
    {
      MetricName: 'CheckFailure',
      Value: o.status === 'fail' ? 1 : 0,
      Unit: StandardUnit.Count,
      Timestamp: timestamp,
      Dimensions: [{ Name: 'Check', Value: o.name }],
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
  ]);
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
