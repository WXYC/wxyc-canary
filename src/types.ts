/**
 * A single canary check that exercises one user-facing surface of the WXYC
 * stack. Each check returns a result; failures don't throw — they're a
 * first-class state so a single broken endpoint doesn't short-circuit the
 * rest of the run.
 */
export type Check = {
  /** Stable identifier; used as a CloudWatch metric dimension. Keep [a-z-]+ so it's grep-friendly. */
  name: string;
  /** Human-readable description shown in alerts. */
  description: string;
  /** Whether this check can run without DJ credentials. */
  requiresAuth: boolean;
  /**
   * Whether this check mutates Backend-Service state. The runner skips a
   * `writes: true` check unless `CANARY_ENABLE_WRITE_PROBE=true` is set —
   * makes the v0 → v1 transition opt-in per environment, and keeps unit
   * tests that don't mock the write endpoints from accidentally exercising
   * them. Defaults to false (read-only).
   */
  writes?: boolean;
  /**
   * The actual probe. Throws on failure with a message that's safe to alert
   * on. May optionally return a `CheckResult` carrying custom metrics the
   * runner should publish (see CheckResult docs).
   */
  run: (ctx: CheckContext) => Promise<void | CheckResult>;
};

/**
 * Optional return shape for `Check.run`. A check that just verifies a 2xx
 * response can return undefined (treated as pass with no custom metrics).
 *
 * `metrics` — each entry is published twice (once with the `Check`
 * dimension for dashboards, once dimensionless for alarms) per the
 * convention pinned in CLAUDE.md and wxyc-canary#13. The CloudWatch unit
 * is inferred from the key suffix:
 *   - ends in `Seconds` → `StandardUnit.Seconds`
 *   - ends in `Milliseconds` → `StandardUnit.Milliseconds`
 *   - otherwise → `StandardUnit.Count`
 *
 * `skipped` — the check decided not to run for a non-failure reason (e.g.
 * "another DJ is on-air" for the write canary). The runner records the
 * outcome as `status: 'skipped'` with the `skipReason` as the message.
 * This is distinct from throwing, which records as `status: 'fail'`.
 */
export type CheckResult = {
  skipped?: true;
  skipReason?: string;
  metrics?: Record<string, number>;
};

export type CheckContext = {
  backendUrl: string;
  authUrl: string;
  semanticIndexUrl: string;
  /** Bearer token if the canary has logged in as a DJ; undefined for anonymous-only runs. */
  djBearerToken: string | undefined;
  /**
   * Auth user id of the canary DJ. Write-canary checks send this as the
   * `dj_id` in `/flowsheet/join` and `/flowsheet/end` request bodies.
   * Undefined when sign-in failed or no credentials were configured.
   */
  djUserId: string | undefined;
  /**
   * Wall-clock budget the enrichment-quality check spends polling its
   * sentinel row. Default 45_000 leaves 15s of headroom under the 60s
   * Lambda timeout for the other checks to also finish. Overridable so
   * tests don't actually wait 45 seconds.
   */
  enrichmentPollTimeoutMs: number;
  /** Spacing between poll iterations for the enrichment-quality check. */
  enrichmentPollIntervalMs: number;
};

export type CheckOutcome = {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  latencyMs: number;
  /** Failure message if status === 'fail'. */
  message?: string;
  /** Per-check custom metrics — see CheckResult docs above. */
  metrics?: Record<string, number>;
};

export type CanaryConfig = {
  backendUrl: string;
  authUrl: string;
  semanticIndexUrl: string;
  /**
   * Sent as `Origin:` on auth calls (sign-in, token exchange). Must match one
   * of the auth server's `BETTER_AUTH_TRUSTED_ORIGINS` or sign-in returns
   * `MISSING_OR_NULL_ORIGIN`. Defaults to `https://dj.wxyc.org` (prod).
   */
  originUrl?: string;
  /** Optional DJ login. If unset, DJ-auth checks are skipped (not failed). */
  djEmail?: string;
  djPassword?: string;
  /** Per-check timeout, ms. Defaults to 8000. */
  timeoutMs?: number;
  /** AWS region for CloudWatch metric publishing. Defaults to us-east-1. */
  awsRegion?: string;
  /** Disable CloudWatch metric publishing (used in local + test runs). */
  publishMetrics?: boolean;
  /**
   * Enable write-canary checks. Defaults to false. When false, any check
   * declared with `writes: true` downgrades to `skipped` (a distinct
   * metric from `fail`). Set `CANARY_ENABLE_WRITE_PROBE=true` to flip
   * on in deployed environments.
   */
  enableWriteProbe?: boolean;
  /** See CheckContext.enrichmentPollTimeoutMs. */
  enrichmentPollTimeoutMs?: number;
  /** See CheckContext.enrichmentPollIntervalMs. */
  enrichmentPollIntervalMs?: number;
};
