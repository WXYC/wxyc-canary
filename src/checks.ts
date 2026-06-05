import { canaryFetch, type FetchResult } from './client.js';
import { runEnrichmentCheck } from './enrichment-check.js';
import type { Check, CheckResult } from './types.js';

/**
 * The canonical artist used for read-side probes. Stereolab has been on
 * heavy rotation at WXYC for ~30 years; the catalog has multiple releases
 * indexed under this name, so a search returning zero rows is a real
 * regression rather than a data-shape edge case.
 */
const PROBE_ARTIST = 'Stereolab';

/** Anonymous: control. Confirms BS process is up and the load balancer routes to it. */
const healthcheck: Check = {
  name: 'backend-healthcheck',
  description: 'GET /healthcheck on Backend-Service',
  requiresAuth: false,
  run: async (ctx) => {
    const r = await canaryFetch(`${ctx.backendUrl}/healthcheck`);
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
  },
};

/**
 * Exercises the iOS proxy path through Backend-Service into LML. Catches
 * LML being down/timing out and any regression in the BS proxy controller.
 * Uses the DJ bearer because the proxy route is `requirePermissions({})` —
 * any authed JWT works; we don't need a true anonymous-device session to
 * cover the BS→LML hop.
 */
const proxyLibrarySearch: Check = {
  name: 'proxy-library-search',
  description: 'GET /proxy/library/search — exercises BS → LML',
  requiresAuth: true,
  run: async (ctx) => {
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(
      `${ctx.backendUrl}/proxy/library/search?artist=${encodeURIComponent(PROBE_ARTIST)}&limit=5`,
      { headers: { Authorization: `Bearer ${ctx.djBearerToken}` } }
    );
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    const body = r.body as { results?: unknown };
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new Error(`expected {results: [...]}, got: ${r.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * Anonymous: semantic-index Graph API. Mirrors the iOS searchArtist call
 * and would have caught semantic-index outages. Doesn't catch iOS-side
 * decoder drift on its own — that lives in the iOS test suite — but it
 * does catch the server returning 5xx or shape regressions like
 * `results` disappearing.
 */
const semanticIndexSearch: Check = {
  name: 'semantic-index-search',
  description: 'GET /graph/artists/search on explore.wxyc.org',
  requiresAuth: false,
  run: async (ctx) => {
    const r = await canaryFetch(
      `${ctx.semanticIndexUrl}/graph/artists/search?q=${encodeURIComponent(PROBE_ARTIST)}&limit=1`
    );
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    const body = r.body as { results?: unknown };
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new Error(`expected {results: [...]}, got: ${r.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * DJ-authenticated: the catalog-search endpoint dj-site uses for
 * autocomplete. This is the exact path that 503'd on 2026-04-30 because of
 * the cached `library.artist_name` precondition. Hitting it under a real
 * DJ JWT reproduces the failure mode that incident exhibited.
 */
const djLibrarySearch: Check = {
  name: 'dj-library-search',
  description: 'GET /library/?artist_name=... as DJ — catches catalog-search 503',
  requiresAuth: true,
  run: async (ctx) => {
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(`${ctx.backendUrl}/library/?artist_name=${encodeURIComponent(PROBE_ARTIST)}&n=5`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
    });
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    if (!Array.isArray(r.body)) {
      throw new Error(`expected array body, got ${typeof r.body}: ${r.rawText.slice(0, 200)}`);
    }
    if ((r.body as unknown[]).length === 0) {
      throw new Error(`expected at least 1 hit for ${PROBE_ARTIST}, got 0 — catalog search is degraded`);
    }
  },
};

/**
 * DJ-authenticated: the flowsheet read endpoint dj-site polls every 60s.
 * Doesn't catch the play_order index incident (that's on POST), but does
 * catch read-side regressions. Targets v1 because v2 (PR #182) isn't
 * deployed yet — flip to `/v2/flowsheet?n=5` once it ships.
 */
const djFlowsheetRead: Check = {
  name: 'dj-flowsheet-read',
  description: 'GET /flowsheet?n=5 as DJ',
  requiresAuth: true,
  run: async (ctx) => {
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(`${ctx.backendUrl}/flowsheet?n=5`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
    });
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
  },
};

/**
 * DJ-authenticated: the rotation dropdown query. Currently this returns a
 * count that omits the 147 active NULL-album_id rows due to the INNER JOIN
 * bug filed as #689. The canary doesn't assert a specific count (that
 * would lock in the bug) but does catch when rotation goes empty entirely
 * or the endpoint 5xx's.
 */
const djRotation: Check = {
  name: 'dj-rotation',
  description: 'GET /library/rotation as DJ',
  requiresAuth: true,
  run: async (ctx) => {
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(`${ctx.backendUrl}/library/rotation`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
    });
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    if (!Array.isArray(r.body)) {
      throw new Error(`expected array body, got ${typeof r.body}: ${r.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * DJ-authenticated: the dj-site rotation picker. On selecting a rotation
 * row in the flowsheet entry UI, dj-site calls `GET /library/rotation/{id}/tracks`
 * to populate a track dropdown. The endpoint was the user-visible failure
 * surface of BS#994 / BS#1030: when LML was under cascade load, individual
 * release-id lookups timed out, the controller short-circuited to 502, and
 * on-air DJs saw "Loading tracks..." that never resolved. BS#1029 made 21%
 * of active rotation rows JOIN-resolvable (no LML call needed), but the
 * remaining ~79% still depend on the runtime cascade — so this probe both
 * pins the JOIN path stays healthy and acts as a leading indicator for the
 * cascade-class regression that surfaced today via on-air Slack messages
 * rather than any monitor.
 *
 * Self-healing target: rather than hardcode a rotation id (which would
 * break when that row gets killed), the probe discovers a candidate from
 * the rotation list itself. Any 2xx + array response is a pass — the body
 * is allowed to be empty because a real release may have zero indexed
 * tracks (e.g., never cross-referenced with Discogs). The 8 s per-fetch
 * timeout in `canaryFetch` is the regression signal: BS#994's cascade was
 * a 30 s timeout chain → 502, so anything that gets within shouting
 * distance of the budget produces a `fail`.
 */
const djRotationPicker: Check = {
  name: 'dj-rotation-picker',
  description: 'GET /library/rotation/{id}/tracks as DJ — catches BS#994 / BS#1030 cascade-to-502 class',
  requiresAuth: true,
  run: async (ctx): Promise<CheckResult | void> => {
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const list = await canaryFetch(`${ctx.backendUrl}/library/rotation`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
    });
    if (!list.ok) {
      throw new Error(`rotation list precondition: expected 2xx, got ${list.status}: ${list.rawText.slice(0, 200)}`);
    }
    if (!Array.isArray(list.body)) {
      throw new Error(`rotation list precondition: expected array body, got ${typeof list.body}`);
    }
    const first = list.body[0] as { id?: number } | undefined;
    if (!first || typeof first.id !== 'number') {
      // The dj-rotation check already alerts on an empty rotation; this probe
      // intentionally degrades to skipped so the picker signal doesn't
      // duplicate that one. With rotation empty there's nothing to probe.
      return { skipped: true, skipReason: 'rotation list is empty — no probe target available' };
    }
    const tracks = await canaryFetch(`${ctx.backendUrl}/library/rotation/${first.id}/tracks`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
    });
    if (!tracks.ok) {
      throw new Error(`expected 2xx, got ${tracks.status}: ${tracks.rawText.slice(0, 200)}`);
    }
    if (!Array.isArray(tracks.body)) {
      throw new Error(`expected array body, got ${typeof tracks.body}: ${tracks.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * Synthetic bearer used by the lml-auth check's known-bad probe. Must NOT
 * match a real bearer pattern — if the real `LML_API_KEY` ever drifted to
 * this value the canary would silently lose the auth-disabled signal. The
 * `wxyc-canary-probe-` prefix keeps any accidental leak grepable and the
 * `not-a-real-key` suffix is the obvious "do not use" marker.
 */
const LML_KNOWN_BAD_BEARER = 'wxyc-canary-probe-not-a-real-key';

/**
 * Direct POST to LML's `/api/v1/lookup` with the production
 * `LML_API_KEY` bearer. Catches `LML_API_KEY` rotation drift in
 * isolation from the BS proxy path: `proxy-library-search` exercises
 * BS→LML through a DJ JWT, so a missing bearer there fails as "BS lost
 * the header" rather than "the LML bearer is stale". This check removes
 * BS from the loop entirely. Layer-1 mitigation for BS#1094 — the
 * silent backfill stall the org saw the last time the bearer was
 * rotated without a coordinated rollout (Sentry per row, no aggregated
 * alarm, predicate didn't know about auth).
 *
 * Two probes per tick:
 *   1. Known-good bearer (`ctx.lmlApiKey`) must return 2xx. 401/403 here
 *      is the rotation-drift signal; 5xx points at LML itself.
 *   2. Known-bad bearer (`wxyc-canary-probe-not-a-real-key`) must return
 *      401/403. A 200 means LML's auth flag was disabled or rolled back
 *      (LML_REQUIRE_AUTH=false) and the good-bearer probe alone can't
 *      detect that — the broader regression the parent BS#1094 was filed
 *      to catch. Distinct error message ("auth disabled") so operator
 *      routing differs from rotation drift (which is "re-coordinate
 *      consumer rotation", not "re-enable LML auth").
 *
 * Skips when no LML bearer is configured (operator gap, mirrors the
 * DJ-credentials pattern). The probe payload uses a canonical
 * WXYC-representative fixture (Juana Molina / DOGA / la paradoja) from
 * `wxyc-shared`'s example data so the request body is indistinguishable
 * from a real DJ lookup. We don't assert on the `results` shape — that's
 * `proxy-library-search`'s job; this check scopes to "the bearer is
 * accepted and LML answered 2xx" plus "the known-bad bearer is rejected".
 */
const lmlAuth: Check = {
  name: 'lml-auth',
  description:
    'POST /api/v1/lookup directly to LML with LML_API_KEY — catches BS#1094 bearer rotation drift + LML_REQUIRE_AUTH=false',
  requiresAuth: false,
  run: async (ctx): Promise<CheckResult | void> => {
    if (!ctx.lmlApiKey) {
      return { skipped: true, skipReason: 'no LML_API_KEY configured' };
    }
    const body = JSON.stringify({
      artist: 'Juana Molina',
      album: 'DOGA',
      song: 'la paradoja',
      raw_message: 'Juana Molina - la paradoja (DOGA)',
    });

    // Probe 1: known-good bearer must succeed.
    const good = await canaryFetch(`${ctx.lmlUrl}/api/v1/lookup`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.lmlApiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (good.status === 401 || good.status === 403) {
      // Distinct message so the operator sees "rotation drift" not "LML
      // down". The bearer is rolled across BS + rom + tubafrenzy + canary;
      // a 401/403 here means at least one of those is wedged the same way.
      throw new Error(
        `LML rejected bearer with ${good.status} (likely LML_API_KEY rotation drift): ${good.rawText.slice(0, 200)}`
      );
    }
    if (!good.ok) {
      throw new Error(`expected 2xx, got ${good.status}: ${good.rawText.slice(0, 200)}`);
    }

    // Probe 2: known-bad bearer must be rejected. Catches LML_REQUIRE_AUTH
    // being flipped off or rolled back — the silent regression the
    // good-bearer probe alone can't see.
    const bad = await canaryFetch(`${ctx.lmlUrl}/api/v1/lookup`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LML_KNOWN_BAD_BEARER}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (bad.status === 200) {
      // LML accepted a deliberately-bad bearer — auth is disabled upstream.
      // Operator routing differs from rotation drift: this is "re-enable
      // LML auth" (a regression), not "rotate the shared secret".
      throw new Error(
        `LML accepted known-bad bearer with 200 — auth disabled upstream (LML_REQUIRE_AUTH likely flipped to false): ${bad.rawText.slice(0, 200)}`
      );
    }
    if (bad.status !== 401 && bad.status !== 403) {
      // Ambiguous: not a clean "auth enabled" (401/403) and not a clean
      // "auth disabled" (200). 5xx falls here. Surface as its own class so
      // it doesn't get conflated with the good-bearer 5xx ("LML down") path.
      throw new Error(
        `LML returned ${bad.status} for known-bad bearer (expected 401/403): ${bad.rawText.slice(0, 200)}`
      );
    }
  },
};

/**
 * Liveness probe for the EC2-hosted self-hosted GitHub Actions runner
 * (label `e2e-runner`) that backs the staging-gate suites in
 * Backend-Service, library-metadata-lookup, and dj-site. Wired up as
 * part of WXYC/wiki#80 phase 1; the runner bootstrap + runbook live in
 * wxyc-shared (`scripts/e2e-runner/`).
 *
 * Probe: `GET /orgs/{org}/actions/runners/{id}` with a fine-scoped PAT.
 * Pass on `status === "online"`. Fail on any other status (`offline`
 * is the spec's primary failure mode), 404 (runner id no longer exists
 * after a host replacement that didn't re-set the stack parameter),
 * 401/403 (PAT rotation drift), or 5xx (GitHub itself degraded — rare
 * but distinct enough to surface separately).
 *
 * The existing `wxyc-canary-check-failure` alarm gives the spec's
 * "≥10 minutes of `status != online`" window for free: 3 evaluations ×
 * 5 min, 2 datapoints to alarm = ~10 min sustained breach. No new
 * alarm needed.
 *
 * Skip semantics mirror `lml-auth` / DJ credentials: missing PAT or
 * runner-id is an operator gap (alarm stays quiet), but a downstream
 * resolution error fails (real signal, paged).
 */
const ghaRunnerOnline: Check = {
  name: 'gha-runner-online',
  description: 'GET /orgs/{org}/actions/runners/{id} — staging-gate runner liveness',
  requiresAuth: false,
  run: async (ctx): Promise<CheckResult | void> => {
    // Check the runner-id sentinel before the token: when both are missing
    // the id is the load-bearing knob (a configured probe without a token
    // would fail to resolve; a configured token without an id would have
    // nothing to probe). Surfacing "no runner id" first matches the
    // dominant operator failure mode.
    //
    // Defense-in-depth on the runner-id sentinel. The CFN HasGhaRunnerProbe
    // condition strips the env var to '' when GhaRunnerId=0; the env loader
    // turns '' into undefined. But non-CFN deploy paths (local invoke, manual
    // env override, a future template refactor) can land NaN (typo) or 0
    // (sentinel) or non-positive-integer values. `typeof NaN === 'number'`
    // and `typeof 0 === 'number'`, so a bare `typeof !== 'number'` is not
    // enough — without isInteger/`> 0` the URL would template `/runners/NaN`
    // or `/runners/0` and 404, mis-routing to "runner was likely replaced".
    if (typeof ctx.ghaRunnerId !== 'number' || !Number.isInteger(ctx.ghaRunnerId) || ctx.ghaRunnerId <= 0) {
      return {
        skipped: true,
        skipReason:
          ctx.ghaRunnerId === undefined
            ? 'no runner id configured (CANARY_GHA_RUNNER_ID)'
            : `invalid runner id (CANARY_GHA_RUNNER_ID=${ctx.ghaRunnerId}); expected positive integer`,
      };
    }
    if (!ctx.ghaRunnerToken) {
      return { skipped: true, skipReason: 'no GitHub PAT configured for runner-liveness probe' };
    }
    // Normalize a trailing slash on the API base. Operator copy-paste
    // hazard — GH today tolerates `//orgs/...` but a path-strict proxy or
    // future GH rev would 404 and the failure would mis-route through the
    // "runner replaced" runbook.
    const apiBase = ctx.ghaRunnerApiBase.replace(/\/+$/, '');
    const url = `${apiBase}/orgs/${ctx.ghaRunnerOrg}/actions/runners/${ctx.ghaRunnerId}`;
    const r = await canaryFetch(url, {
      headers: {
        Authorization: `Bearer ${ctx.ghaRunnerToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (r.status === 404) {
      // Runner id no longer exists — the operator replaced the host and
      // did not re-set the CFN parameter. Distinct from "offline" so the
      // on-call routes to the replacement runbook, not "the runner died".
      // NOTE: a fine-scoped PAT with insufficient scope ALSO returns 404
      // (GitHub hides resources from underprivileged tokens). The runbook
      // entry for this message must mention the PAT-scope possibility as a
      // second-line check after the operator confirms the runner id.
      throw new Error(
        `GitHub returned 404 for runner id ${ctx.ghaRunnerId} — runner was likely replaced (or PAT lacks Self-hosted runners: Read scope); re-set GhaRunnerId or rotate PAT: ${r.rawText.slice(0, 200)}`
      );
    }
    if (r.status === 403) {
      // 403 is overloaded: primary rate-limit returns 403 with `X-RateLimit-
      // Remaining: 0` and a body mentioning "rate limit". PAT rotation
      // drift returns 403 too. Disambiguate so on-call doesn't rotate a
      // perfectly valid PAT chasing a transient rate-limit window.
      const remaining = r.headers?.['x-ratelimit-remaining'];
      const bodyText = r.rawText.toLowerCase();
      if (remaining === '0' || bodyText.includes('rate limit') || bodyText.includes('secondary rate')) {
        const reset = r.headers?.['x-ratelimit-reset'];
        const resetSuffix = reset ? ` (reset epoch ${reset})` : '';
        // Phrased to keep the on-call away from PAT-rotation actions: the
        // PAT is valid; the bucket needs to refill.
        throw new Error(
          `GitHub rate limit exceeded${resetSuffix} — wait for the bucket to reset; the PAT is valid: ${r.rawText.slice(0, 200)}`
        );
      }
      throw new Error(
        `GitHub rejected PAT with 403 — rotate the runner-liveness PAT in SSM: ${r.rawText.slice(0, 200)}`
      );
    }
    if (r.status === 401) {
      // PAT is revoked / expired / malformed. Operator action: rotate the
      // SSM parameter — different runbook entry from "runner down" or "rate
      // limit".
      throw new Error(
        `GitHub rejected PAT with 401 — rotate the runner-liveness PAT in SSM: ${r.rawText.slice(0, 200)}`
      );
    }
    if (r.status >= 500) {
      // GitHub itself is degraded. Route the on-call to githubstatus.com
      // before they SSH the runner or rotate the PAT — the runner has
      // nothing to do with this failure. The docstring above promised this
      // would be a distinct surface; here it actually is.
      throw new Error(
        `GitHub API degraded (status ${r.status}) — check githubstatus.com before investigating the runner: ${r.rawText.slice(0, 200)}`
      );
    }
    if (!r.ok) {
      throw new Error(`expected 2xx from GitHub runner endpoint, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    }
    const body = r.body as { status?: string; name?: string; id?: number };
    if (!body || typeof body !== 'object' || typeof body.status !== 'string') {
      throw new Error(`expected {status: string} from GitHub runner endpoint, got: ${r.rawText.slice(0, 200)}`);
    }
    if (body.status !== 'online') {
      // The spec's primary failure mode: the runner stopped polling
      // GitHub (host wedge, systemd unit died, network egress to
      // github.com broken). Include the human-readable name so the
      // alarm message points the on-call at the right host.
      throw new Error(
        `runner ${body.name ?? `id=${ctx.ghaRunnerId}`} is offline (status="${body.status}") — investigate per scripts/e2e-runner/README.md`
      );
    }
  },
};

/**
 * Write canary (v1). Inserts a sentinel flowsheet row, polls until LML
 * enrichment populates `youtube_music_url`, deletes the row, ends the
 * canary's show. Returns an `EnrichmentLagSeconds` metric the runner
 * publishes as the `EnrichmentLag` CloudWatch series the
 * `wxyc-canary-enrichment-lag` alarm targets.
 *
 * Opt-in via `CANARY_ENABLE_WRITE_PROBE=true` (default off). With the flag
 * off, the runner downgrades this check to skipped — keeps existing
 * deployments unchanged and lets the rollout proceed environment-by-env.
 *
 * Built for the 2026-05-13 LML cascade regression that left 70% of new
 * playcut entries with null metadata for 2+ days while the read-only
 * checks (`proxy-library-search`, `dj-flowsheet-read`) all stayed green
 * — same shapes, just no enrichment behind them.
 */
const enrichmentQuality: Check = {
  name: 'enrichment-quality',
  description: 'Insert sentinel track + poll until LML enrichment populates youtube_music_url',
  requiresAuth: true,
  writes: true,
  run: async (ctx) => runEnrichmentCheck(ctx),
};

export const checks: readonly Check[] = [
  healthcheck,
  proxyLibrarySearch,
  semanticIndexSearch,
  djLibrarySearch,
  djFlowsheetRead,
  djRotation,
  djRotationPicker,
  lmlAuth,
  ghaRunnerOnline,
  enrichmentQuality,
];

/**
 * Parse a `Retry-After` header in seconds form (the date form is rare on
 * better-auth and not handled). Returns milliseconds, or undefined when
 * the header is missing/unparseable. Negative or non-finite values are
 * treated as missing.
 */
function parseRetryAfterMs(result: FetchResult): number | undefined {
  const raw = result.headers?.['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Sign in to better-auth as a DJ and return a JWT suitable for the
 * `Authorization: Bearer ...` header on Backend-Service routes. Throws on
 * any failure — caller is responsible for downgrading DJ-auth checks to
 * skipped when this throws and credentials weren't supplied.
 *
 * Two-step: `/sign-in/email` returns a session token (cookie-equivalent),
 * then `/token` exchanges the session for a JWT. Backend-Service's
 * `requirePermissions` middleware verifies JWTs against the JWKS endpoint,
 * so the session token alone gets a 401 — the exchange is mandatory.
 *
 * `originUrl` is sent as the `Origin` header on both calls. better-auth's
 * CSRF guard rejects sign-in with `MISSING_OR_NULL_ORIGIN` when the header
 * is absent (curl, Lambda, anything non-browser). The value must be one of
 * the auth server's `BETTER_AUTH_TRUSTED_ORIGINS`.
 *
 * Retry carve-out: the canary deliberately does not retry the surfaces it
 * measures (see `client.ts`). Sign-in is the exception, and only on 429.
 * Auth is a precondition shared by 4 of 6 checks, so a single 429 here
 * cascades into 4 simultaneous fail outcomes plus a Lambda Errors alarm —
 * even when the surfaces being measured are healthy. One retry, only on
 * 429, only on the sign-in step (token exchange does not retry). Honors
 * `Retry-After` (seconds form) when present, capped to 5s so the Lambda
 * still finishes inside its budget.
 */
// `userId` is best-effort: a missing user.id only fails the write canary
// (which throws its own preflight error when `ctx.djUserId` is undefined).
// Read-only DJ-auth checks tolerate the absence so a better-auth response-
// shape rev doesn't cascade into four false-positive failures.
export type DjSignInResult = { jwt: string; userId: string | undefined };

export async function signInDj(
  authUrl: string,
  email: string,
  password: string,
  originUrl: string
): Promise<DjSignInResult> {
  const postSignIn = (): Promise<FetchResult> =>
    canaryFetch(`${authUrl}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: originUrl },
      body: JSON.stringify({ email, password }),
    });

  let signIn = await postSignIn();
  if (signIn.status === 429) {
    const delayMs = Math.min(parseRetryAfterMs(signIn) ?? 2000, 5000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    signIn = await postSignIn();
  }
  if (!signIn.ok) {
    throw new Error(`auth sign-in failed with ${signIn.status}: ${signIn.rawText.slice(0, 200)}`);
  }
  const signInBody = signIn.body as { token?: string; user?: { id?: string } };
  if (!signInBody || typeof signInBody.token !== 'string' || signInBody.token.length === 0) {
    throw new Error(`auth sign-in returned no session token: ${signIn.rawText.slice(0, 200)}`);
  }
  const sessionToken = signInBody.token;
  const userId =
    signInBody.user && typeof signInBody.user.id === 'string' && signInBody.user.id.length > 0
      ? signInBody.user.id
      : undefined;

  const tokenExchange = await canaryFetch(`${authUrl}/token`, {
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: originUrl },
  });
  if (!tokenExchange.ok) {
    throw new Error(`auth token exchange failed with ${tokenExchange.status}: ${tokenExchange.rawText.slice(0, 200)}`);
  }
  const tokenBody = tokenExchange.body as { token?: string };
  if (!tokenBody || typeof tokenBody.token !== 'string' || tokenBody.token.length === 0) {
    throw new Error(`auth token exchange returned no JWT: ${tokenExchange.rawText.slice(0, 200)}`);
  }
  return { jwt: tokenBody.token, userId };
}
