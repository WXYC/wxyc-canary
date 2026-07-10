import { CloudWatchClient, PutMetricDataCommand, StandardUnit, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { checks, signInDj } from './checks.js';
import { reportOutcomesToGitHub } from './github-issues.js';
import type { CanaryConfig, Check, CheckContext, CheckOutcome, CheckResult } from './types.js';

const METRIC_NAMESPACE = 'WXYC/Canary';
const DEFAULT_ENRICHMENT_POLL_TIMEOUT_MS = 45_000;
const DEFAULT_ENRICHMENT_POLL_INTERVAL_MS = 2_000;

/**
 * Paging tier per check name, resolved once from the single source of truth
 * (the `checks` array, which `handler.ts` already imports). `pagesOncall !==
 * false` so both the default (undefined) and explicit `true` page — only an
 * explicit `false` (the two infra probes) opts out. `publishMetrics` uses
 * this to route each outcome into the `UserFacingCheckFailure` (page) or
 * `InfraCheckFailure` (low-urgency) dimensionless aggregate. See
 * wxyc-canary#48 and CLAUDE.md "Conventions".
 */
const pagesOncallByName = new Map<string, boolean>(checks.map((c) => [c.name, c.pagesOncall !== false]));

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
    lmlUrl: process.env.CANARY_LML_URL ?? 'https://library-metadata-lookup-production.up.railway.app',
    lmlApiKey: process.env.CANARY_LML_API_KEY,
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
    ghaRunnerApiBase: process.env.CANARY_GHA_RUNNER_API_BASE,
    ghaRunnerOrg: process.env.CANARY_GHA_RUNNER_ORG,
    // Pass NaN through verbatim: the check layer treats anything that isn't
    // a positive integer as "skip with invalid-id reason", so an operator
    // typo (e.g. CANARY_GHA_RUNNER_ID=abc → Number → NaN) surfaces as a
    // skipped check with a precise reason rather than a misrouted 404.
    ghaRunnerId: process.env.CANARY_GHA_RUNNER_ID ? Number(process.env.CANARY_GHA_RUNNER_ID) : undefined,
    ghaRunnerToken: process.env.CANARY_GHA_RUNNER_TOKEN,
    // OIDC authorize probe (wxyc-canary#60). Defaults match the trusted
    // client registered in WXYC/Backend-Service#1576 — the placeholder
    // redirect URI never resolves; the check reads the 302 Location with
    // `redirect: 'manual'` and never follows it. Overridable so a
    // future rev of the trusted client's shape (rename, second redirect)
    // doesn't require a code change here.
    oidcProbeClientId: process.env.CANARY_OIDC_PROBE_CLIENT_ID,
    oidcProbeRedirectUri: process.env.CANARY_OIDC_PROBE_REDIRECT_URI,
  };
}

/**
 * Resolve DJ credentials from one of two sources, in order:
 *   1. `config.djEmail` + `config.djPassword` (set by the Lambda's
 *      env loader or the CLI's flag-parser).
 *   2. `env.CANARY_DJ_SECRET_ARN` pointing at a Secrets Manager secret
 *      with a JSON value of shape `{"email": "...", "password": "..."}`.
 * Returns undefined when neither is configured — DJ-auth checks downgrade
 * to skipped in that case.
 *
 * `env` is passed explicitly (not read from `process.env`) so callers
 * that want to suppress the SecretsManager fallback can pass a
 * sanitized env. The CLI does exactly that — its README contracts on
 * "never instantiates the AWS SDK", and an operator with
 * `CANARY_DJ_SECRET_ARN` in their shell would otherwise silently
 * trigger SDK instantiation despite the CLI's intent.
 */
async function resolveDjCredentials(
  config: CanaryConfig,
  env: NodeJS.ProcessEnv
): Promise<{ email: string; password: string } | undefined> {
  if (config.djEmail && config.djPassword) {
    return { email: config.djEmail, password: config.djPassword };
  }
  const secretArn = env.CANARY_DJ_SECRET_ARN;
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
 * Resolve the LML bearer from one of two sources, in order:
 *   1. `config.lmlApiKey` (set by env loader / CLI flag-parser).
 *   2. `env.CANARY_LML_API_KEY_SECRET_ARN` pointing at a Secrets Manager
 *      secret whose `SecretString` is the bearer itself (plain string,
 *      not JSON — Railway-style secret-store convention so the bearer
 *      rotates in one place across BS + rom + tubafrenzy + canary).
 * Returns undefined when neither is configured — the `lml-auth` check
 * then downgrades to skipped (operator gap, not regression).
 *
 * See `resolveDjCredentials` for the env-parameter rationale.
 */
async function resolveLmlApiKey(config: CanaryConfig, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (config.lmlApiKey) return config.lmlApiKey;
  const secretArn = env.CANARY_LML_API_KEY_SECRET_ARN;
  if (!secretArn) return undefined;

  const sm = new SecretsManagerClient({ region: config.awsRegion ?? 'us-east-1' });
  const result = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error(`secret ${secretArn} has no SecretString`);
  }
  return result.SecretString;
}

/**
 * Resolve the GitHub PAT used by the `gha-runner-online` check, in order:
 *   1. `config.ghaRunnerToken` (set by env loader / CLI flag-parser).
 *   2. `env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM` → SSM SecureString.
 * Returns undefined when neither is configured — the check then skips
 * with reason. The PAT is stored in SSM (not Secrets Manager) to match
 * the existing GitHub-issues-reporter PAT, which keeps all GitHub-PAT
 * storage co-located under `/wxyc-canary/*` for the same rotation
 * cadence and IAM grant pattern.
 *
 * See `resolveDjCredentials` for the env-parameter rationale.
 */
async function resolveGhaRunnerToken(config: CanaryConfig, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (config.ghaRunnerToken) return config.ghaRunnerToken;
  const paramName = env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM;
  if (!paramName) return undefined;

  const ssm = new SSMClient({ region: config.awsRegion ?? 'us-east-1' });
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${paramName} has no Value`);
  }
  return value;
}

/**
 * Run every check, regardless of individual failures. Returns one outcome
 * per check. DJ-auth checks downgrade to 'skipped' when no DJ credentials
 * are configured — distinct from 'fail' so the alarm only fires on real
 * regressions, not on operator-caused gaps. Write-canary checks also
 * downgrade to 'skipped' when `enableWriteProbe=false` (the default).
 *
 * `opts.checks` overrides which checks run — the CLI passes
 * `checksForSuite('smoke')` here so the staging-gate workflow runs the
 * BS+LML subset and skips Lambda-only probes (runner-liveness, writes).
 * Lambda callers omit the opt and get the full `checks` array. Credential
 * resolution + ctx assembly happen unconditionally so the per-check skip
 * logic (lml-auth no-bearer, dj-* no-creds) still works when the suite
 * happens to include the affected check.
 */
export async function runCanary(
  config: CanaryConfig,
  opts?: { checks?: readonly Check[]; env?: NodeJS.ProcessEnv }
): Promise<CheckOutcome[]> {
  const ranChecks = opts?.checks ?? checks;
  // `env` defaults to `process.env` for the Lambda call path (which
  // wants the SecretsManager / SSM fallbacks to fire). The CLI passes
  // a sanitized env so the fallbacks short-circuit on missing env vars
  // and never instantiate any AWS SDK client.
  const env = opts?.env ?? process.env;
  let djCreds: { email: string; password: string } | undefined;
  let djAuthError: string | undefined;
  try {
    djCreds = await resolveDjCredentials(config, env);
  } catch (err) {
    djAuthError = `credential resolution failed: ${(err as Error).message}`;
  }

  // LML bearer resolution is independent of DJ auth: the lml-auth check
  // skips on absence, fails on resolve errors (Secrets Manager outages
  // are real, distinct signals — collapsing them into "skipped" would
  // hide an IAM/SM regression).
  let lmlApiKey: string | undefined;
  let lmlAuthError: string | undefined;
  try {
    lmlApiKey = await resolveLmlApiKey(config, env);
  } catch (err) {
    lmlAuthError = `LML bearer resolution failed: ${(err as Error).message}`;
  }

  // GH runner PAT resolution: skip when the probe isn't configured at all
  // (no runner-id → check would skip anyway), fail when it IS configured
  // and resolution errors (SSM outage / IAM regression — real signal).
  // Asymmetric vs lml-auth on purpose: lml-auth has one knob, this probe
  // has two; resolving the PAT when the operator forgot the runner-id half
  // would page on-call for a probe that wouldn't have run.
  let ghaRunnerToken: string | undefined;
  let ghaRunnerTokenError: string | undefined;
  const probeIdConfigured =
    typeof config.ghaRunnerId === 'number' && Number.isInteger(config.ghaRunnerId) && config.ghaRunnerId > 0;
  if (probeIdConfigured) {
    try {
      ghaRunnerToken = await resolveGhaRunnerToken(config, env);
    } catch (err) {
      ghaRunnerTokenError = `GH runner PAT resolution failed: ${(err as Error).message}`;
    }
  } else {
    // Still resolve the inline (env-provided) token so tests / local runs
    // that pass `ghaRunnerToken` directly through CanaryConfig continue to
    // work even when no runner-id is set. The check will skip; the token
    // is just threaded through ctx for completeness.
    ghaRunnerToken = config.ghaRunnerToken;
  }

  let djBearerToken: string | undefined;
  let djSessionToken: string | undefined;
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
      djSessionToken = signIn.sessionToken;
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
    lmlUrl: config.lmlUrl ?? 'https://library-metadata-lookup-production.up.railway.app',
    lmlApiKey,
    djBearerToken,
    djSessionToken,
    djUserId,
    enrichmentPollTimeoutMs: config.enrichmentPollTimeoutMs ?? DEFAULT_ENRICHMENT_POLL_TIMEOUT_MS,
    enrichmentPollIntervalMs: config.enrichmentPollIntervalMs ?? DEFAULT_ENRICHMENT_POLL_INTERVAL_MS,
    // `||` (not `??`) on the two string defaults so an empty-string env
    // value also picks up the default. The CFN template wires
    // CANARY_GHA_RUNNER_ORG unconditionally, so even probe-disabled stacks
    // forward 'WXYC' here; but a future template change that sets either
    // to '' (or a manual override) must NOT compose a URL like
    // `/orgs//actions/...` and 404 with a misleading "runner replaced"
    // failure.
    ghaRunnerApiBase: config.ghaRunnerApiBase || 'https://api.github.com',
    ghaRunnerOrg: config.ghaRunnerOrg || 'WXYC',
    ghaRunnerId: config.ghaRunnerId,
    ghaRunnerToken,
    // `||` (not `??`) so an empty-string env value picks up the default —
    // an operator who accidentally sets `CANARY_OIDC_PROBE_CLIENT_ID=` in
    // `.env` should still get the WXYC-registered probe client, not an
    // empty `client_id` query param that better-auth rejects with
    // `invalid_client`. Same rule the runner-liveness fields use above.
    oidcProbeClientId: config.oidcProbeClientId || 'wxyc-canary',
    oidcProbeRedirectUri: config.oidcProbeRedirectUri || 'https://canary.wxyc.invalid/authorize-echo',
  };

  const outcomes = await Promise.all(
    ranChecks.map(async (check): Promise<CheckOutcome> => {
      if (check.requiresAuth && !djCreds && !djAuthError) {
        return { name: check.name, status: 'skipped', latencyMs: 0, message: 'no DJ credentials configured' };
      }
      if (check.requiresAuth && djAuthError) {
        return { name: check.name, status: 'fail', latencyMs: 0, message: `auth precondition failed: ${djAuthError}` };
      }
      // The lml-auth check fails (not skips) when bearer resolution
      // errored — a Secrets Manager outage / IAM regression is a real
      // signal that warrants paging, not a silent skip.
      if (check.name === 'lml-auth' && lmlAuthError) {
        return { name: check.name, status: 'fail', latencyMs: 0, message: lmlAuthError };
      }
      // Same rule for gha-runner-online: an SSM outage / IAM regression
      // is a real signal; collapsing to "skipped" would silently disable
      // the runner-liveness probe.
      if (check.name === 'gha-runner-online' && ghaRunnerTokenError) {
        return { name: check.name, status: 'fail', latencyMs: 0, message: ghaRunnerTokenError };
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
 * dimensionless) per the wxyc-canary#13 convention; the dimensionless
 * `CheckFailure` is now a dashboard rollup (no alarm reads it after the
 * wxyc-canary#48 tier split). Each outcome ALSO emits exactly one tier
 * aggregate — `UserFacingCheckFailure` (the `wxyc-canary-check-failure`
 * page) or `InfraCheckFailure` (the low-urgency `wxyc-canary-infra-degraded`
 * alarm) — routed by `pagesOncallByName`. Custom check metrics
 * (`outcome.metrics`) follow the same emit-twice pattern: once with the
 * `Check` dimension and once dimensionless, so a plain-form alarm can target
 * the dimensionless series without a SUM(SEARCH(...)) expression. Failures
 * stay non-fatal so the Lambda still exits on the outcome list, not on a
 * CloudWatch hiccup.
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
    // Tier-split aggregate (wxyc-canary#48): route this outcome's failure
    // value into exactly one of two dimensionless series. `UserFacingCheckFailure`
    // backs the `wxyc-canary-check-failure` page; `InfraCheckFailure` backs the
    // low-urgency `wxyc-canary-infra-degraded` alarm. An unknown name pages
    // (fail-safe). These are dimensionless-only on purpose — per-surface
    // drill-down is already served by the dimensioned `CheckFailure` above, so
    // a `Tier` dimension or a second dimensioned emission would add cost for no
    // benefit. `failureValue` (skipped/pass → 0) preserves skip-semantics on
    // both tiers.
    const userFacing = pagesOncallByName.get(o.name) ?? true;
    base.push({
      MetricName: userFacing ? 'UserFacingCheckFailure' : 'InfraCheckFailure',
      Value: failureValue,
      Unit: StandardUnit.Count,
      Timestamp: timestamp,
      Dimensions: [],
    });
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
 * even before the custom metrics arrive. The CloudFormation alarms fire on
 * the dimensionless tier aggregates (`UserFacingCheckFailure` page /
 * `InfraCheckFailure` low-urgency); the dimensioned `CheckFailure` series
 * names *which* surface is broken for dashboards and drill-down.
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

// The `npm run local` autorun now lives in `src/handler-local.ts` so
// that `import { runCanary } from './handler.js'` from the CLI never
// fires a Lambda invocation as a top-level side effect. The race was
// real: an operator with `CANARY_LOCAL=true` in their shell would
// otherwise see the Lambda `handler()` execute concurrently with the
// CLI's `runCli` call.
