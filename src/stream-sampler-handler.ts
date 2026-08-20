/**
 * Lambda entry point for the WXYC stream listener sampler (wxyc-canary).
 *
 * Runs on its own EventBridge schedule, separate from the canary function:
 * this samples an audience metric, it does not assert liveness, and it must
 * never be able to trip a canary alarm or be silenced by one. Sharing the
 * repo buys the SAM/deploy/test plumbing and the WXYC AWS account; sharing a
 * Lambda would entangle two different jobs.
 *
 * Cost is fixed by construction: one HTTP GET and at most one PostHog event
 * per invocation, so the 5-minute schedule pins ingestion at 288 events/day
 * no matter what the stream is doing. See `stream-sampler.ts` for why that
 * invariant is load-bearing.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

import { CanaryFetchError, canaryFetch } from './client.js';
import { type CaptureEvent, buildCapturePayload, buildFailurePayload, sampleWxycMounts } from './stream-sampler.js';

export type SamplerConfig = {
  statusUrl: string;
  posthogHost: string;
  posthogApiKey: string | undefined;
  environment: string;
  mountPrefix: string;
  primaryMount: string;
  timeoutMs: number;
  captureEnabled: boolean;
  familyAttemptTimeoutMs: number;
  readRetries: number;
};

/**
 * Raises Node's Happy Eyeballs per-family connect budget.
 *
 * `audio-mp3.ibiblio.org` is dual-stack (A + AAAA) and legitimately takes
 * anywhere from 350ms to ~2.4s to answer. Node's default
 * `autoSelectFamilyAttemptTimeout` is 250ms, so the connection attempt was
 * being abandoned before a healthy server could respond — measured at 3 of 6
 * samples lost locally, surfacing as a bare `ETIMEDOUT` about 255ms in, which
 * reads like a dead host rather than a client-side deadline. Raising the
 * budget took a 12-sample run to 12/12 with a slowest legitimate response of
 * 2438ms.
 *
 * This is a process-wide setting, which is safe here only because the sampler
 * is its own Lambda and its own bundle — it must not be hoisted into shared
 * code where it would silently change the canary's connect behaviour.
 */
export function configureNetworking(config: SamplerConfig): void {
  setDefaultAutoSelectFamilyAttemptTimeout(config.familyAttemptTimeoutMs);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SamplerConfig {
  return {
    statusUrl: env.SAMPLER_ICECAST_STATUS_URL ?? 'https://audio-mp3.ibiblio.org/status-json.xsl',
    posthogHost: env.SAMPLER_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    // Read with `??` so an intentionally-blank value from CloudFormation
    // survives as the "capture disabled" signal instead of falling back to a
    // default, matching the canary's CANARY_LEGACY_PLAYLIST_URL lever.
    posthogApiKey: env.SAMPLER_POSTHOG_API_KEY ?? undefined,
    environment: env.SAMPLER_ENVIRONMENT ?? 'production',
    mountPrefix: env.SAMPLER_MOUNT_PREFIX ?? 'wxyc',
    primaryMount: env.SAMPLER_PRIMARY_MOUNT ?? 'wxyc.mp3',
    timeoutMs: env.SAMPLER_TIMEOUT_MS ? Number(env.SAMPLER_TIMEOUT_MS) : 8000,
    // Dry-run lever for local runs: parse and log without writing to PostHog.
    captureEnabled: env.SAMPLER_CAPTURE_ENABLED !== 'false',
    familyAttemptTimeoutMs: env.SAMPLER_FAMILY_ATTEMPT_TIMEOUT_MS
      ? Number(env.SAMPLER_FAMILY_ATTEMPT_TIMEOUT_MS)
      : 3000,
    readRetries: env.SAMPLER_READ_RETRIES ? Number(env.SAMPLER_READ_RETRIES) : 1,
  };
}

/**
 * Reads the Icecast status document, retrying a bounded number of times.
 *
 * This deliberately diverges from `client.ts`'s no-retry rule. That rule
 * exists because a retry can mask a real brownout, which defeats the purpose
 * of a canary. The sampler is not a canary: a dropped read here is a hole in a
 * continuous time series — lost data, not a masked signal — so one cheap retry
 * is strictly better than a gap.
 *
 * Only the READ is retried. The PostHog capture is never retried: a write that
 * timed out may well have landed, and a duplicate sample double-counts a
 * quarter-hour, which corrupts the average more than a missing one does.
 */
async function fetchStatus(config: SamplerConfig) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.readRetries; attempt++) {
    try {
      const response = await canaryFetch(config.statusUrl, { timeoutMs: config.timeoutMs });
      if (!response.ok) throw new Error(`status ${response.status}`);
      return response;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * POSTs one event to PostHog's capture API.
 *
 * A raw fetch instead of `posthog-node` on purpose. The SDK batches and
 * flushes asynchronously, which is a well-known footgun under Lambda: the
 * execution environment freezes the moment the handler resolves and any
 * unflushed batch is lost, so a "successful" invocation silently drops its
 * sample. One event per invocation has nothing to batch, so the SDK's only
 * contribution would be a cold-start dependency and a lost-event hazard.
 */
async function capture(event: CaptureEvent, config: SamplerConfig): Promise<void> {
  const result = await canaryFetch(`${config.posthogHost}/i/v0/e/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    timeoutMs: config.timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`posthog capture returned ${result.status}: ${result.rawText.slice(0, 200)}`);
  }
}

export type SamplerResult = {
  captured: boolean;
  event: string | null;
  totalListeners: number | null;
  streamOnline: boolean | null;
  mounts: string[];
  reason?: string;
};

export async function runSampler(
  config: SamplerConfig = loadConfig(),
  now: () => Date = () => new Date()
): Promise<SamplerResult> {
  configureNetworking(config);

  const timestamp = now().toISOString();
  const context = {
    apiKey: config.posthogApiKey ?? '',
    timestamp,
    environment: config.environment,
  };

  let payload: CaptureEvent;
  let result: SamplerResult;

  try {
    const response = await fetchStatus(config);
    if (typeof response.body !== 'object' || response.body === null) {
      throw new Error('status endpoint returned non-JSON body');
    }

    const sample = sampleWxycMounts(response.body, {
      mountPrefix: config.mountPrefix,
      primaryMount: config.primaryMount,
    });
    payload = buildCapturePayload(sample, context);
    result = {
      captured: false,
      event: payload.event,
      totalListeners: sample.totalListeners,
      streamOnline: sample.streamOnline,
      mounts: sample.mounts.map((m) => m.mount),
    };
  } catch (err) {
    const reason = err instanceof CanaryFetchError || err instanceof Error ? err.message : String(err);
    payload = buildFailurePayload({ ...context, reason });
    result = {
      captured: false,
      event: payload.event,
      totalListeners: null,
      streamOnline: null,
      mounts: [],
      reason,
    };
  }

  if (!config.captureEnabled || !config.posthogApiKey) {
    return { ...result, reason: result.reason ?? 'capture disabled (no api key)' };
  }

  await capture(payload, config);
  return { ...result, captured: true };
}

export async function handler(): Promise<SamplerResult> {
  const result = await runSampler();
  // Structured single-line log; CloudWatch Logs is the audit trail for a job
  // whose only other output is a write to a third party.
  console.log(JSON.stringify({ sampler: 'wxyc-stream-listeners', ...result }));
  return result;
}
