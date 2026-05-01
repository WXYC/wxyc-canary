import { canaryFetch } from './client.js';
import type { Check } from './types.js';

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

export const checks: readonly Check[] = [
  healthcheck,
  proxyLibrarySearch,
  semanticIndexSearch,
  djLibrarySearch,
  djFlowsheetRead,
  djRotation,
];

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
 */
export async function signInDj(authUrl: string, email: string, password: string, originUrl: string): Promise<string> {
  const signIn = await canaryFetch(`${authUrl}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: originUrl },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) {
    throw new Error(`auth sign-in failed with ${signIn.status}: ${signIn.rawText.slice(0, 200)}`);
  }
  const signInBody = signIn.body as { token?: string };
  if (!signInBody || typeof signInBody.token !== 'string' || signInBody.token.length === 0) {
    throw new Error(`auth sign-in returned no session token: ${signIn.rawText.slice(0, 200)}`);
  }
  const sessionToken = signInBody.token;

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
  return tokenBody.token;
}
