/**
 * Named subset of `checks` invokable from the CLI. The Lambda always runs
 * the full `checks` array, ignoring suite tags. Add a suite by extending
 * this union AND `VALID_SUITES` in `checks.ts` AND tagging the checks that
 * belong to it. Future likely additions: `'dj-site'` for the dj-site
 * staging gate, `'full'` for an ad-hoc local sweep.
 */
export type Suite = 'smoke';

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
   * CLI suite membership. Untagged checks are unreachable from the CLI
   * (Lambda-only). The set of valid suite tags is the `Suite` union;
   * `checksForSuite(suite)` filters the global `checks` array by
   * `suites?.includes(suite)`.
   */
  suites?: readonly Suite[];
  /**
   * Whether a failure of this check pages the operator via the
   * `wxyc-canary-check-failure` alarm. Default true (fail-safe: a new check
   * pages until explicitly opted out). Set false ONLY for infra/CI probes
   * that are not DJ-facing surfaces — currently `gha-runner-online` and
   * `semantic-index-freshness`. Explicit, type-checked, and deliberately NOT
   * derived from `suites`: the untagged `dj-rotation` / `dj-rotation-picker`
   * are user-facing and must keep the true default. Routes the failure into
   * the `UserFacingCheckFailure` (page) vs `InfraCheckFailure` (low-urgency)
   * dimensionless aggregate in `publishMetrics`.
   */
  pagesOncall?: boolean;
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

/**
 * One OIDC probe target — `clientId` + `redirectUri` + human-readable
 * `label`. The label is what shows up in an alert message when this
 * specific probe fails; it lets the runbook route (e.g. "WikiJS registration
 * missing" vs "canary trusted client misconfigured") without the on-call
 * reading Location headers. Today the env loader always produces exactly
 * one probe with label `'wxyc-canary'`; the array shape exists so a second
 * consumer registers with a pure config change. See wxyc-canary#63.
 */
export type OidcProbe = {
  clientId: string;
  redirectUri: string;
  label: string;
};

export type CheckContext = {
  backendUrl: string;
  authUrl: string;
  semanticIndexUrl: string;
  /**
   * library-metadata-lookup base URL (no trailing slash). The `lml-auth`
   * check POSTs directly here to detect LML_API_KEY rotation drift in
   * isolation from the BS proxy path that `proxy-library-search` also
   * exercises.
   */
  lmlUrl: string;
  /**
   * Production LML bearer (the shared service-to-service secret that BS,
   * rom, and tubafrenzy also send). Undefined when neither the
   * `CANARY_LML_API_KEY` env var nor a `CANARY_LML_API_KEY_SECRET_ARN`
   * Secrets Manager secret is configured — the `lml-auth` check then
   * downgrades to skipped (operator-configuration gap, not regression —
   * same pattern as the DJ credentials).
   */
  lmlApiKey: string | undefined;
  /** Bearer token if the canary has logged in as a DJ; undefined for anonymous-only runs. */
  djBearerToken: string | undefined;
  /**
   * Raw better-auth session token returned by `/sign-in/email` — the
   * OIDC authorize probe (wxyc-canary#60) sends it as
   * `Authorization: Bearer ...` on `/oauth2/authorize`. The better-auth
   * `bearer` plugin translates it into the session cookie the authorize
   * endpoint reads. Distinct from `djBearerToken`: that one is the JWT
   * from `/token`, which is what BS routes accept but `/oauth2/authorize`
   * rejects (different audience). Undefined when sign-in failed.
   */
  djSessionToken: string | undefined;
  /**
   * Auth user id of the canary DJ. Write-canary checks send this as the
   * `dj_id` in `/flowsheet/join` and `/flowsheet/end` request bodies.
   * Undefined when sign-in failed or no credentials were configured.
   */
  djUserId: string | undefined;
  /**
   * OIDC probes to exercise on `/oauth2/authorize`. Array-shape so a
   * second consumer (WikiJS, additional in-house tools) can register a
   * per-client probe and any per-client trusted-client misregistration
   * surfaces with the failing probe's `label` in the alert — routing to
   * the right owner rather than the generic "OIDC is broken." The runtime
   * check iterates every probe on a single tick; each failing probe
   * contributes its `label`-prefixed message to the combined error so a
   * multi-client regression lands in one alarm, not N.
   *
   * Non-empty by construction: the env loader always produces at least
   * one probe (the `wxyc-canary` trusted client from
   * WXYC/Backend-Service#1576) — the tuple type expresses that so the
   * runtime code never has to defend against an empty array. Today the
   * env vars still produce exactly one probe; wiring a second is a
   * pure configuration change once a second client registers, no code
   * changes needed. See wxyc-canary#63.
   */
  oidcProbes: readonly [OidcProbe, ...OidcProbe[]];
  /**
   * Wall-clock budget the enrichment-quality check spends polling its
   * sentinel row. Default 45_000 leaves 15s of headroom under the 60s
   * Lambda timeout for the other checks to also finish. Overridable so
   * tests don't actually wait 45 seconds.
   */
  enrichmentPollTimeoutMs: number;
  /** Spacing between poll iterations for the enrichment-quality check. */
  enrichmentPollIntervalMs: number;
  /**
   * GitHub REST API base for the runner-liveness probe (no trailing
   * slash). Defaults to `https://api.github.com` in the handler when
   * unset; overridable so tests can route to a synthetic host.
   */
  ghaRunnerApiBase: string;
  /**
   * GitHub organization that owns the self-hosted runner. Defaults to
   * `WXYC`.
   */
  ghaRunnerOrg: string;
  /**
   * Numeric runner id assigned by GitHub on registration. Required for
   * the `gha-runner-online` check to run — undefined → skip with reason.
   * The id changes when the runner is replaced (re-registration), so
   * the operator must re-set the CFN parameter after an instance swap.
   */
  ghaRunnerId: number | undefined;
  /**
   * Fine-scoped PAT with `admin:org → Self-hosted runners: Read`
   * (classic) or the fine-grained equivalent (`Administration` /
   * `Self-hosted runners` on the org). Undefined → check skips.
   * Resolution errors (Secrets Manager / SSM IAM regressions) fail
   * rather than skip, mirroring the lml-auth bearer-resolution path.
   */
  ghaRunnerToken: string | undefined;
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
   * library-metadata-lookup base URL (no trailing slash). Defaults to
   * `https://library-metadata-lookup-production.up.railway.app` in the
   * handler when unset.
   */
  lmlUrl?: string;
  /**
   * Production LML bearer (shared with BS, rom, tubafrenzy). When unset,
   * the `lml-auth` check downgrades to skipped — same operator-gap
   * semantics as the DJ-credentials path.
   */
  lmlApiKey?: string;
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
  /** See CheckContext.ghaRunnerApiBase. */
  ghaRunnerApiBase?: string;
  /** See CheckContext.ghaRunnerOrg. */
  ghaRunnerOrg?: string;
  /** See CheckContext.ghaRunnerId. */
  ghaRunnerId?: number;
  /**
   * GH PAT for the runner-liveness probe. Either set this directly
   * (`CANARY_GHA_RUNNER_TOKEN` env, local/test) or set
   * `CANARY_GHA_RUNNER_TOKEN_SSM_PARAM` for SSM SecureString resolution
   * (prod). When unset and no SSM param is configured, the
   * `gha-runner-online` check downgrades to skipped.
   */
  ghaRunnerToken?: string;
  /**
   * OIDC probe trusted-client id. Sent as `client_id` on `/oauth2/authorize`.
   * The handler folds this + `oidcProbeRedirectUri` into a single-entry
   * `CheckContext.oidcProbes` array (wxyc-canary#63) — today the env loader
   * always produces exactly one probe, and this pair is the wire. Defaults
   * to `'wxyc-canary'` in the handler.
   */
  oidcProbeClientId?: string;
  /**
   * OIDC probe redirect URI paired with `oidcProbeClientId`. See the
   * `oidcProbeClientId` doc for the array-fold contract. Defaults to
   * `'https://canary.wxyc.invalid/authorize-echo'` in the handler
   * (RFC 2606 `.invalid` TLD — BS#1584).
   */
  oidcProbeRedirectUri?: string;
};
