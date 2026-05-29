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
