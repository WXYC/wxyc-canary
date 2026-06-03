import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { handler, runCanary } from '../src/handler.js';
import type { CanaryConfig } from '../src/types.js';

// Module-mock hoisting: vi.mock is hoisted above imports, so the mock factory
// must use vi.hoisted() to share the spy with test assertions. Placing the
// spy in vi.hoisted ensures it exists when the mocked module is constructed.
const { cloudWatchSendMock, ssmSendMock, reportOutcomesToGitHubMock } = vi.hoisted(() => ({
  cloudWatchSendMock: vi.fn(async () => ({})),
  ssmSendMock: vi.fn(async () => ({ Parameter: { Value: 'fake-pat' } })),
  reportOutcomesToGitHubMock: vi.fn(async () => undefined),
}));
vi.mock('@aws-sdk/client-cloudwatch', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudwatch')>('@aws-sdk/client-cloudwatch');
  return {
    ...actual,
    CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudWatchSendMock })),
  };
});
vi.mock('@aws-sdk/client-ssm', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ssm')>('@aws-sdk/client-ssm');
  return {
    ...actual,
    SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  };
});
vi.mock('../src/github-issues.js', () => ({
  reportOutcomesToGitHub: reportOutcomesToGitHubMock,
}));

const baseConfig: CanaryConfig = {
  backendUrl: 'https://api.example.test',
  authUrl: 'https://auth.example.test',
  semanticIndexUrl: 'https://explore.example.test',
  publishMetrics: false,
};

const stereolabSearchResults = [
  {
    id: 1,
    code_letters: 'STE',
    code_artist_number: 100,
    code_number: 1,
    artist_name: 'Stereolab',
    album_title: 'Aluminum Tunes',
    label: 'Duophonic',
  },
];

const proxyLibrarySearchResponse = { results: stereolabSearchResults, total: 1, query: 'Stereolab' };

function setUpFetchMock(responses: Record<string, { status: number; body: unknown }>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const [pattern, resp] of Object.entries(responses)) {
      if (urlString.includes(pattern)) {
        return new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(`unmatched mock for ${urlString}`, { status: 599 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runCanary — anonymous-only configuration', () => {
  beforeEach(() => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 97426, canonical_name: 'stereolab' }] } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the 2 truly-anonymous checks and skips the 7 conditional checks when no credentials are configured', async () => {
    const outcomes = await runCanary(baseConfig);

    expect(outcomes).toHaveLength(9);
    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    expect(byName['backend-healthcheck'].status).toBe('pass');
    expect(byName['semantic-index-search'].status).toBe('pass');
    expect(byName['proxy-library-search'].status).toBe('skipped');
    expect(byName['dj-library-search'].status).toBe('skipped');
    expect(byName['dj-flowsheet-read'].status).toBe('skipped');
    expect(byName['dj-rotation'].status).toBe('skipped');
    expect(byName['dj-rotation-picker'].status).toBe('skipped');
    expect(byName['enrichment-quality'].status).toBe('skipped');
    // `lml-auth` skips on missing LML_API_KEY (operator gap) — same
    // semantics as DJ credentials but a separate config switch. The
    // `baseConfig` fixture leaves `lmlApiKey` undefined.
    expect(byName['lml-auth'].status).toBe('skipped');
    expect(byName['lml-auth'].message).toMatch(/no LML_API_KEY configured/);
  });
});

describe('runCanary — failure surfaces (regression coverage for the 2026-04-30 incidents)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('catches catalog-search returning 503 (the actual incident shape)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/library/?artist_name=': {
        status: 503,
        body: { message: 'library.artist_name has 1 NULL row(s); catalog search is disabled.' },
      },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation': { status: 200, body: [] },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;

    expect(dj.status).toBe('fail');
    expect(dj.message).toMatch(/503/);
    expect(dj.message).toMatch(/library\.artist_name/);
  });

  it('catches semantic-index returning a wrapped object missing the results key', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { something_else: [] } },
    });

    const outcomes = await runCanary(baseConfig);
    const semantic = outcomes.find((o) => o.name === 'semantic-index-search')!;

    expect(semantic.status).toBe('fail');
    expect(semantic.message).toMatch(/expected \{results: \[\.\.\.\]\}/);
  });

  it('catches LML/proxy returning 504 (LML degradation)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/proxy/library/search': { status: 504, body: { message: 'LML request timed out' } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation': { status: 200, body: [] },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const proxy = outcomes.find((o) => o.name === 'proxy-library-search')!;

    expect(proxy.status).toBe('fail');
    expect(proxy.message).toMatch(/504/);
  });

  it('catches catalog-search succeeding but returning zero rows (silent regression)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/library/?artist_name=': { status: 200, body: [] },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation': { status: 200, body: [] },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;

    expect(dj.status).toBe('fail');
    expect(dj.message).toMatch(/at least 1 hit/);
  });

  // Regression coverage for the BS#994 / BS#1029 / BS#1030 cluster. Without
  // this check, the rotation-picker endpoint was only exercised when an
  // on-air DJ tried to log a rotation track — outages surfaced as a
  // "Loading tracks..." spinner that a DJ Slacked in, not as a metric.
  // BS#1029 made 21% of active rotation rows JOIN-resolvable; the picker
  // probe pins that the endpoint stays 2xx + array-shaped, so a future
  // regression of either the JOIN path or the runtime cascade pages within
  // ~5 min instead of waiting for someone to spot the spinner.
  it('catches the rotation picker returning 502 (BS#1030 cascade-to-502 regression class)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation/21522/tracks': { status: 502, body: { message: 'lookupReleaseId: LML cascade timed out' } },
      '/library/rotation': { status: 200, body: [{ id: 21522 }] },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const picker = outcomes.find((o) => o.name === 'dj-rotation-picker')!;

    expect(picker.status).toBe('fail');
    expect(picker.message).toMatch(/502/);
  });

  it('passes the picker probe when the rotation list yields an id and /tracks returns an array', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation/4242/tracks': { status: 200, body: [{ id: 1, title: 'la paradoja' }] },
      '/library/rotation': { status: 200, body: [{ id: 4242 }] },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const picker = outcomes.find((o) => o.name === 'dj-rotation-picker')!;

    expect(picker.status).toBe('pass');
  });

  it('skips the picker probe when the rotation list is empty (cannot synthesize a probe target)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation': { status: 200, body: [] },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const picker = outcomes.find((o) => o.name === 'dj-rotation-picker')!;

    expect(picker.status).toBe('skipped');
    expect(picker.message).toMatch(/rotation/i);
  });

  it('does not short-circuit other checks when one fails', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 500, body: { error: 'oops' } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation': { status: 200, body: [] },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    expect(byName['backend-healthcheck'].status).toBe('fail');
    expect(byName['proxy-library-search'].status).toBe('pass');
    expect(byName['semantic-index-search'].status).toBe('pass');
  });

  it('downgrades DJ-auth checks to fail (not skipped) when sign-in itself errors', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      '/sign-in/email': { status: 401, body: { error: 'invalid credentials' } },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'wrong' });
    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;

    expect(dj.status).toBe('fail');
    expect(dj.message).toMatch(/auth precondition failed/);
  });

  it('downgrades DJ-auth checks to fail when the session→JWT exchange errors (regression: cookie-style token alone gets 401 on backend routes)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 500, body: { error: 'jwks unavailable' } },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;

    expect(dj.status).toBe('fail');
    expect(dj.message).toMatch(/auth precondition failed/);
    expect(dj.message).toMatch(/token exchange/);
  });
});

/**
 * `lml-auth` is the layer-1 mitigation for BS#1094 — silent
 * `LML_API_KEY` rotation drift. It POSTs `/api/v1/lookup` directly to
 * LML with the production bearer and asserts 200. 401/403 is the
 * rotation-drift signal (distinct error message so the operator
 * doesn't confuse it with LML being down); 5xx is the LML-down
 * signal. Missing bearer is operator gap → skipped, not failed.
 *
 * URL match patterns here use the production LML host suffix because
 * the `lml-auth` check hits LML directly, not via BS. `setUpFetchMock`
 * matches on substring, so any unique part of the LML URL works; we
 * use the full path `/api/v1/lookup` since the BS proxy uses the same
 * substring fragment (`/library`), which would shadow this match
 * otherwise.
 */
describe('runCanary — lml-auth check (BS#1094 layer 1)', () => {
  const lmlAuthConfig: CanaryConfig = {
    ...baseConfig,
    // Distinct host so the check hits a substring no other mock matches.
    lmlUrl: 'https://lml.example.test',
    lmlApiKey: 'fake-lml-bearer',
  };

  /**
   * The lml-auth check fires two probes per tick: one with the configured
   * bearer (known-good), one with a deliberately-bad bearer (the
   * `wxyc-canary-probe-not-a-real-key` sentinel). Both probes hit the same
   * URL so the existing URL-substring mock can't distinguish them. This
   * helper inspects the `Authorization` header to route the response,
   * letting each test pin the four-quadrant outcome matrix (good-200 +
   * bad-401, good-200 + bad-200, good-401 + bad-anything, good-5xx +
   * bad-anything).
   */
  function setUpLmlBearerAwareMock(opts: {
    backendHealthcheck?: { status: number; body: unknown };
    proxyLibrarySearch?: { status: number; body: unknown };
    semanticIndexSearch?: { status: number; body: unknown };
    lmlGoodBearer: { status: number; body: unknown };
    lmlBadBearer: { status: number; body: unknown };
  }) {
    const defaults = {
      backendHealthcheck: { status: 200, body: { ok: true } },
      proxyLibrarySearch: { status: 200, body: proxyLibrarySearchResponse },
      semanticIndexSearch: { status: 200, body: { results: [{ id: 1 }] } },
    };
    const merged = { ...defaults, ...opts };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const respond = (resp: { status: number; body: unknown }) =>
        new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (urlString.includes('/healthcheck')) return respond(merged.backendHealthcheck);
      if (urlString.includes('/proxy/library/search')) return respond(merged.proxyLibrarySearch);
      if (urlString.includes('/graph/artists/search')) return respond(merged.semanticIndexSearch);
      if (urlString.includes('lml.example.test/api/v1/lookup')) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.Authorization ?? headers.authorization ?? '';
        // The sentinel must be obviously synthetic — anything that doesn't
        // match a real bearer pattern. The implementation chose
        // `wxyc-canary-probe-not-a-real-key` (see src/checks.ts).
        const isBadBearer = auth.includes('wxyc-canary-probe-not-a-real-key');
        return respond(isBadBearer ? opts.lmlBadBearer : opts.lmlGoodBearer);
      }
      return new Response(`unmatched mock for ${urlString}`, { status: 599 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes when LML returns 200 to the good bearer and 401 to the known-bad bearer', async () => {
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 200, body: { results: [], cache_stats: {} } },
      lmlBadBearer: { status: 401, body: { detail: 'Missing or invalid API key' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;
    expect(lml.status).toBe('pass');
  });

  it('passes when LML returns 200 to the good bearer and 403 to the known-bad bearer', async () => {
    // 403 is treated the same as 401 — both mean "auth is enforced and this
    // bearer is not accepted", which is exactly what the known-bad probe is
    // supposed to confirm.
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 200, body: { results: [], cache_stats: {} } },
      lmlBadBearer: { status: 403, body: { detail: 'Forbidden' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;
    expect(lml.status).toBe('pass');
  });

  it('fails with an "auth disabled" message when LML accepts the known-bad bearer (LML_REQUIRE_AUTH=false regression)', async () => {
    // The exact failure mode the issue was filed to catch: LML's auth flag
    // got flipped or rolled back, and any bearer now returns 200. The
    // good-bearer probe is silent on this — only the known-bad probe
    // surfaces it. Distinct error class from rotation drift so the operator
    // routes to "re-enable LML auth", not "rotate the shared secret".
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 200, body: { results: [], cache_stats: {} } },
      lmlBadBearer: { status: 200, body: { results: [], cache_stats: {} } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('fail');
    expect(lml.message).toMatch(/auth disabled/);
    // Must not be mistaken for the rotation-drift failure class — different
    // remediation, different on-call routing.
    expect(lml.message).not.toMatch(/rotation drift/);
  });

  it('fails with an "unexpected status" message when the known-bad bearer returns neither 200 nor 401/403 (e.g. 500)', async () => {
    // A 5xx on the known-bad probe is ambiguous: not a clean "auth enabled"
    // signal, not a clean "auth disabled" signal either. Surface it as its
    // own class so the operator doesn't conflate it with the good-bearer
    // 5xx path (which is the "LML down" message).
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 200, body: { results: [], cache_stats: {} } },
      lmlBadBearer: { status: 500, body: { detail: 'Internal Server Error' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('fail');
    expect(lml.message).toMatch(/known-bad bearer/);
    expect(lml.message).toMatch(/500/);
    expect(lml.message).not.toMatch(/rotation drift/);
    expect(lml.message).not.toMatch(/auth disabled/);
  });

  it('fails with a rotation-drift message when LML returns 401 to the good bearer (the BS#1094 incident shape)', async () => {
    // Good-bearer 401 short-circuits — no need to consult the known-bad
    // probe. Rotation drift is the dominant failure class; calling out the
    // known-bad result here would muddy the operator's runbook.
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 401, body: { detail: 'Missing or invalid API key' } },
      lmlBadBearer: { status: 401, body: { detail: 'Missing or invalid API key' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('fail');
    // The operator-facing distinction: rotation drift vs LML down. A
    // generic "expected 2xx" message would lose the BS#1094 signal.
    expect(lml.message).toMatch(/rotation drift/);
    expect(lml.message).toMatch(/401/);
  });

  it('fails with the same rotation-drift message on good-bearer 403 (forbidden — bearer recognised but revoked)', async () => {
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 403, body: { detail: 'Forbidden' } },
      lmlBadBearer: { status: 401, body: { detail: 'Missing or invalid API key' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('fail');
    expect(lml.message).toMatch(/rotation drift/);
    expect(lml.message).toMatch(/403/);
  });

  it('fails with a generic 5xx message when LML itself is down (not a rotation-drift signal)', async () => {
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 503, body: { detail: 'Service Unavailable' } },
      lmlBadBearer: { status: 503, body: { detail: 'Service Unavailable' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('fail');
    // No rotation-drift framing — the operator's diagnostic path
    // (page rom, page LML on-call) is different from rotation drift.
    expect(lml.message).not.toMatch(/rotation drift/);
    expect(lml.message).not.toMatch(/auth disabled/);
    expect(lml.message).toMatch(/503/);
  });

  it('sends the bearer as Authorization: Bearer and posts a structured artist/album/song body', async () => {
    const fetchMock = setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 200, body: { results: [], cache_stats: {} } },
      lmlBadBearer: { status: 401, body: { detail: 'Missing or invalid API key' } },
    });

    await runCanary(lmlAuthConfig);

    const lmlCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('lml.example.test/api/v1/lookup'));
    // Two probes per tick: one with the configured bearer, one with the
    // synthetic known-bad bearer.
    expect(lmlCalls).toHaveLength(2);
    const [, goodInit] = lmlCalls[0] as unknown as [unknown, RequestInit];
    expect(goodInit.method).toBe('POST');
    const goodHeaders = goodInit.headers as Record<string, string>;
    expect(goodHeaders.Authorization).toBe('Bearer fake-lml-bearer');
    expect(goodHeaders['Content-Type']).toBe('application/json');
    // The payload must carry a real artist/album/song so it exercises
    // LML's `perform_lookup` rather than short-circuiting on empty
    // input. Use a canonical WXYC-representative fixture.
    const body = JSON.parse(goodInit.body as string);
    expect(body.artist).toBeTypeOf('string');
    expect(body.artist.length).toBeGreaterThan(0);
    expect(body.album).toBeTypeOf('string');
    expect(body.song).toBeTypeOf('string');

    const [, badInit] = lmlCalls[1] as unknown as [unknown, RequestInit];
    const badHeaders = badInit.headers as Record<string, string>;
    // The sentinel bearer must be obviously synthetic — never overlap with
    // a real bearer pattern. If this ever changes, the bearer-aware mock
    // in this file needs the matching string updated.
    expect(badHeaders.Authorization).toBe('Bearer wxyc-canary-probe-not-a-real-key');
    expect(badHeaders['Content-Type']).toBe('application/json');
  });

  it('skips when no LML_API_KEY is configured (operator gap, not regression)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
    });

    const outcomes = await runCanary({ ...baseConfig, lmlUrl: 'https://lml.example.test' });
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('skipped');
    expect(lml.message).toMatch(/no LML_API_KEY configured/);
  });
});

/**
 * Auth sign-in is the one place the canary retries (see signInDj). The
 * carve-out exists because a single 429 on sign-in cascades into 4 fail
 * outcomes plus a Lambda Errors alarm, even when the surfaces being
 * measured are healthy. These tests pin the contract: retry on 429 only,
 * once only, sign-in step only.
 */
describe('runCanary — sign-in 429 retry carve-out', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Build a fetch mock where each URL pattern returns a queue of responses
   * in order. After the queue is exhausted, the last response repeats —
   * lets a test specify "fail once, then succeed" without enumerating
   * every subsequent call.
   */
  function setUpSequentialFetchMock(
    sequences: Record<string, { status: number; body: unknown; headers?: Record<string, string> }[]>
  ) {
    const calls: Record<string, number> = {};
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      for (const [pattern, queue] of Object.entries(sequences)) {
        if (urlString.includes(pattern)) {
          const idx = calls[pattern] ?? 0;
          calls[pattern] = idx + 1;
          const resp = queue[Math.min(idx, queue.length - 1)];
          return new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
            status: resp.status,
            headers: { 'Content-Type': 'application/json', ...(resp.headers ?? {}) },
          });
        }
      }
      return new Response(`unmatched mock for ${urlString}`, { status: 599 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, calls };
  }

  it('retries sign-in once on 429 and proceeds when the second attempt succeeds', async () => {
    vi.useFakeTimers();
    const { fetchMock } = setUpSequentialFetchMock({
      '/healthcheck': [{ status: 200, body: { ok: true } }],
      '/proxy/library/search': [{ status: 200, body: proxyLibrarySearchResponse }],
      '/graph/artists/search': [{ status: 200, body: { results: [{ id: 1 }] } }],
      '/sign-in/email': [
        { status: 429, body: { error: 'Too many requests, please try again later.' } },
        { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      ],
      '/token': [{ status: 200, body: { token: 'fake-jwt' } }],
      '/library/?artist_name=': [{ status: 200, body: stereolabSearchResults }],
      '/flowsheet': [{ status: 200, body: [] }],
      '/library/rotation': [{ status: 200, body: [] }],
    });

    const promise = runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    await vi.runAllTimersAsync();
    const outcomes = await promise;

    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    expect(byName['proxy-library-search'].status).toBe('pass');
    expect(byName['dj-library-search'].status).toBe('pass');
    expect(byName['dj-flowsheet-read'].status).toBe('pass');
    expect(byName['dj-rotation'].status).toBe('pass');

    const signInCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/sign-in/email'));
    expect(signInCalls).toHaveLength(2);
  });

  it('honors Retry-After (seconds) on 429, capped at 5s', async () => {
    vi.useFakeTimers();
    setUpSequentialFetchMock({
      '/healthcheck': [{ status: 200, body: { ok: true } }],
      '/proxy/library/search': [{ status: 200, body: proxyLibrarySearchResponse }],
      '/graph/artists/search': [{ status: 200, body: { results: [{ id: 1 }] } }],
      '/sign-in/email': [
        // Server asks for 60s — far longer than the canary's budget. We cap at 5s.
        { status: 429, body: { error: 'rate limited' }, headers: { 'Retry-After': '60' } },
        { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      ],
      '/token': [{ status: 200, body: { token: 'fake-jwt' } }],
      '/library/?artist_name=': [{ status: 200, body: stereolabSearchResults }],
      '/flowsheet': [{ status: 200, body: [] }],
      '/library/rotation': [{ status: 200, body: [] }],
    });

    const promise = runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    // Advance exactly 5s (the cap). If the cap weren't applied, the retry timer
    // would still be pending and the sign-in promise wouldn't resolve.
    await vi.advanceTimersByTimeAsync(5000);
    const outcomes = await promise;

    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;
    expect(dj.status).toBe('pass');
  });

  it('fails the precondition when both sign-in attempts return 429', async () => {
    vi.useFakeTimers();
    setUpSequentialFetchMock({
      '/healthcheck': [{ status: 200, body: { ok: true } }],
      '/proxy/library/search': [{ status: 200, body: proxyLibrarySearchResponse }],
      '/graph/artists/search': [{ status: 200, body: { results: [{ id: 1 }] } }],
      '/sign-in/email': [
        { status: 429, body: { error: 'rate limited' } },
        { status: 429, body: { error: 'rate limited' } },
      ],
    });

    const promise = runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    await vi.runAllTimersAsync();
    const outcomes = await promise;

    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;
    expect(dj.status).toBe('fail');
    expect(dj.message).toMatch(/auth precondition failed/);
    expect(dj.message).toMatch(/429/);
  });

  it('does not retry on non-429 sign-in failures (e.g. 401)', async () => {
    const { fetchMock } = setUpSequentialFetchMock({
      '/healthcheck': [{ status: 200, body: { ok: true } }],
      '/proxy/library/search': [{ status: 200, body: proxyLibrarySearchResponse }],
      '/graph/artists/search': [{ status: 200, body: { results: [{ id: 1 }] } }],
      '/sign-in/email': [{ status: 401, body: { error: 'invalid credentials' } }],
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'wrong' });

    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;
    expect(dj.status).toBe('fail');
    expect(dj.message).toMatch(/401/);

    const signInCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/sign-in/email'));
    expect(signInCalls).toHaveLength(1);
  });

  it('does not retry the token-exchange step on 429', async () => {
    const { fetchMock } = setUpSequentialFetchMock({
      '/healthcheck': [{ status: 200, body: { ok: true } }],
      '/proxy/library/search': [{ status: 200, body: proxyLibrarySearchResponse }],
      '/graph/artists/search': [{ status: 200, body: { results: [{ id: 1 }] } }],
      '/sign-in/email': [{ status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } }],
      '/token': [{ status: 429, body: { error: 'rate limited' } }],
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });

    const dj = outcomes.find((o) => o.name === 'dj-library-search')!;
    expect(dj.status).toBe('fail');
    expect(dj.message).toMatch(/token exchange/);

    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/token'));
    expect(tokenCalls).toHaveLength(1);
  });
});

type MetricDatum = {
  MetricName: string;
  Value: number;
  Dimensions?: Array<{ Name: string; Value: string }>;
};

function getPublishedMetrics(): MetricDatum[] {
  expect(cloudWatchSendMock).toHaveBeenCalledTimes(1);
  const [firstCall] = cloudWatchSendMock.mock.calls as unknown as Array<
    [{ input: { Namespace: string; MetricData: MetricDatum[] } }]
  >;
  expect(firstCall[0].input.Namespace).toBe('WXYC/Canary');
  return firstCall[0].input.MetricData;
}

/**
 * The `wxyc-canary-check-failure` alarm targets a plain
 * `Namespace=WXYC/Canary, MetricName=CheckFailure` series with no Dimensions
 * filter. CloudWatch alarms cannot use `SUM(SEARCH(...))` (issue #13), so
 * the canary publishes each `CheckFailure` datapoint twice: once with the
 * `Check` dimension (for dashboards / slicing) and once dimensionless (so a
 * plain alarm aggregates across every check). These regressions pin both
 * emissions, the failure-case value flow, and the dimensioned-only contract
 * for `CheckSkipped` / `CheckLatency` (alarming on those would be noise).
 */
describe('publishMetrics — dimensioned + dimensionless emit-twice', () => {
  beforeEach(() => {
    cloudWatchSendMock.mockClear();
    process.env.CANARY_BACKEND_URL = 'https://api.example.test';
    process.env.CANARY_AUTH_URL = 'https://auth.example.test';
    process.env.CANARY_SEMANTIC_INDEX_URL = 'https://explore.example.test';
    process.env.CANARY_PUBLISH_METRICS = 'true';
    delete process.env.CANARY_DJ_EMAIL;
    delete process.env.CANARY_DJ_PASSWORD;
    delete process.env.CANARY_DJ_SECRET_ARN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CANARY_PUBLISH_METRICS;
  });

  it('emits each CheckFailure datapoint twice — once with the Check dimension and once dimensionless', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 97426, canonical_name: 'stereolab' }] } },
    });

    await handler();

    const checkFailureData = getPublishedMetrics().filter((d) => d.MetricName === 'CheckFailure');
    const dimensioned = checkFailureData.filter((d) => d.Dimensions && d.Dimensions.length > 0);
    const dimensionless = checkFailureData.filter((d) => !d.Dimensions || d.Dimensions.length === 0);

    // Nine checks, each contributes one dimensioned and one dimensionless datapoint.
    expect(dimensioned).toHaveLength(9);
    expect(dimensionless).toHaveLength(9);
    // Without an inducer, every value is 0 (passes + skips).
    expect(dimensioned.every((d) => d.Value === 0)).toBe(true);
    expect(dimensionless.every((d) => d.Value === 0)).toBe(true);
  });

  // The alarm reads the dimensionless series. If a regression flowed
  // `failureValue` into only the dimensioned branch, the dashboard would
  // light up but the pager wouldn't — exactly the failure mode this pins.
  it('flows the failure value (1) into both the dimensioned and dimensionless emission for the failing check', async () => {
    setUpFetchMock({
      // backend-healthcheck fails; everything else passes (DJ-auth checks
      // skip with no creds — skipped is not a failure).
      '/healthcheck': { status: 500, body: { error: 'oops' } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
    });

    await expect(handler()).rejects.toThrow(/canary failed/);

    const checkFailureData = getPublishedMetrics().filter((d) => d.MetricName === 'CheckFailure');
    const dimensioned = checkFailureData.filter((d) => d.Dimensions && d.Dimensions.length > 0);
    const dimensionless = checkFailureData.filter((d) => !d.Dimensions || d.Dimensions.length === 0);

    const failingDimensioned = dimensioned.find((d) => d.Dimensions![0].Value === 'backend-healthcheck')!;
    expect(failingDimensioned.Value).toBe(1);

    // Exactly one dimensionless datapoint carries the failure value (the
    // one paired with backend-healthcheck); the rest are 0. Value-matching
    // isn't enough — `Statistic: Maximum` on the alarm needs at least one
    // `1` in the window, so this asserts the count of 1s explicitly.
    expect(dimensionless.filter((d) => d.Value === 1)).toHaveLength(1);
    expect(dimensionless.filter((d) => d.Value === 0)).toHaveLength(8);
  });

  // `CheckSkipped` and `CheckLatency` are dashboard data, not alarm inputs.
  // A future "let's mirror everything" refactor that also published their
  // dimensionless companions would pollute the namespace and risk a
  // misconfigured alarm being added against them — pin the contract.
  it('emits CheckSkipped and CheckLatency dimensioned-only (no dimensionless companion)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 97426, canonical_name: 'stereolab' }] } },
    });

    await handler();

    const metricData = getPublishedMetrics();
    const isDimensionless = (d: MetricDatum) => !d.Dimensions || d.Dimensions.length === 0;
    expect(metricData.filter((d) => d.MetricName === 'CheckSkipped' && isDimensionless(d))).toHaveLength(0);
    expect(metricData.filter((d) => d.MetricName === 'CheckLatency' && isDimensionless(d))).toHaveLength(0);
    // Sanity: the dimensioned series for each is present (one per check).
    expect(metricData.filter((d) => d.MetricName === 'CheckSkipped')).toHaveLength(9);
    expect(metricData.filter((d) => d.MetricName === 'CheckLatency')).toHaveLength(9);
  });
});

/**
 * Catches the wxyc-canary#13 drift class: an alarm in `template.yaml` that
 * targets a (Namespace, MetricName, Dimensions) tuple the Lambda never
 * actually publishes. The alarm definition (YAML) and metric emission (TS)
 * live in separate files, so without a runtime contract test they can drift
 * silently and a real outage parks the alarm at "no data" instead of paging.
 *
 * Scope is intentionally one-directional: alarms must point at metrics the
 * code emits, but the code is free to emit dashboard-only metrics that no
 * alarm references. And only `Namespace: WXYC/Canary` is checked — alarms on
 * `AWS/Lambda` or other namespaces target metrics outside this repo.
 */
describe('template.yaml ↔ publishMetrics contract', () => {
  type AlarmSpec = {
    resourceName: string;
    alarmName: string;
    namespace: string;
    metricName: string;
    dimensionNames: string[];
  };

  /**
   * Both alarm shapes CloudFormation accepts: the simple form (top-level
   * Namespace/MetricName/Dimensions) and the expression form, where the
   * underlying metric lives on a `Metrics: [{MetricStat: {Metric: {...}}}]`
   * entry. We extract every metric-source the alarm references, so adding
   * an expression-form alarm later doesn't silently bypass this test.
   */
  function extractMetricSources(properties: Record<string, unknown>): {
    namespace: string;
    metricName: string;
    dimensionNames: string[];
  }[] {
    const sources: { namespace: string; metricName: string; dimensionNames: string[] }[] = [];
    const dimensionNames = (dims: unknown): string[] => {
      if (!Array.isArray(dims)) return [];
      return dims
        .map((d) => (d && typeof d === 'object' && 'Name' in d ? String((d as { Name: unknown }).Name) : null))
        .filter((n): n is string => n !== null);
    };

    if (typeof properties.Namespace === 'string' && typeof properties.MetricName === 'string') {
      sources.push({
        namespace: properties.Namespace,
        metricName: properties.MetricName,
        dimensionNames: dimensionNames(properties.Dimensions),
      });
    }

    const metrics = properties.Metrics;
    if (Array.isArray(metrics)) {
      for (const entry of metrics) {
        const stat = (entry as { MetricStat?: { Metric?: Record<string, unknown> } })?.MetricStat;
        const metric = stat?.Metric;
        if (metric && typeof metric.Namespace === 'string' && typeof metric.MetricName === 'string') {
          sources.push({
            namespace: metric.Namespace,
            metricName: metric.MetricName,
            dimensionNames: dimensionNames(metric.Dimensions),
          });
        }
      }
    }
    return sources;
  }

  function loadCanaryAlarms(): AlarmSpec[] {
    const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'template.yaml');
    const text = readFileSync(templatePath, 'utf-8');
    // logLevel: silent suppresses CFN tag warnings (`!Ref`, `!Sub`, etc.) —
    // the parser still produces a usable tree; we just don't resolve those
    // tags because none of them appear in alarm metric-selector fields.
    const doc = YAML.parse(text, { logLevel: 'silent' }) as {
      Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
    };
    const resources = doc.Resources ?? {};
    const alarms: AlarmSpec[] = [];
    for (const [resourceName, resource] of Object.entries(resources)) {
      if (resource?.Type !== 'AWS::CloudWatch::Alarm') continue;
      const props = resource.Properties ?? {};
      const alarmName = typeof props.AlarmName === 'string' ? props.AlarmName : resourceName;
      for (const source of extractMetricSources(props)) {
        if (source.namespace !== 'WXYC/Canary') continue;
        alarms.push({
          resourceName,
          alarmName,
          namespace: source.namespace,
          metricName: source.metricName,
          dimensionNames: source.dimensionNames,
        });
      }
    }
    return alarms;
  }

  // Happy-path env + fetch mocks for every check, including the v1 write
  // canary. The contract test needs all alarms to have at least one
  // matching emission, so every metric the alarm set targets must be
  // produced by this run — that includes `EnrichmentLagSeconds`, which
  // only fires when the write canary is enabled AND the sentinel row
  // enriches successfully. Tests below in the dedicated
  // `enrichment-quality` block exercise failure / skip paths.
  beforeEach(() => {
    cloudWatchSendMock.mockClear();
    process.env.CANARY_BACKEND_URL = 'https://api.example.test';
    process.env.CANARY_AUTH_URL = 'https://auth.example.test';
    process.env.CANARY_SEMANTIC_INDEX_URL = 'https://explore.example.test';
    process.env.CANARY_PUBLISH_METRICS = 'true';
    process.env.CANARY_DJ_EMAIL = 'canary@wxyc.org';
    process.env.CANARY_DJ_PASSWORD = 'pw';
    process.env.CANARY_ENABLE_WRITE_PROBE = 'true';
    process.env.CANARY_ENRICHMENT_POLL_INTERVAL_MS = '5';
    process.env.CANARY_ENRICHMENT_POLL_TIMEOUT_MS = '500';
    delete process.env.CANARY_DJ_SECRET_ARN;
    setUpEnrichmentHappyPathMock();
  });

  // Full env-var cleanup, not just the publish flag — leaving CANARY_BACKEND_URL
  // etc. set bleeds into any later test that expects them unset (e.g., a test
  // asserting "throws when CANARY_BACKEND_URL is missing"). Strict cleanup
  // keeps the describe block self-contained.
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CANARY_BACKEND_URL;
    delete process.env.CANARY_AUTH_URL;
    delete process.env.CANARY_SEMANTIC_INDEX_URL;
    delete process.env.CANARY_PUBLISH_METRICS;
    delete process.env.CANARY_DJ_EMAIL;
    delete process.env.CANARY_DJ_PASSWORD;
    delete process.env.CANARY_ENABLE_WRITE_PROBE;
    delete process.env.CANARY_ENRICHMENT_POLL_INTERVAL_MS;
    delete process.env.CANARY_ENRICHMENT_POLL_TIMEOUT_MS;
  });

  it('every WXYC/Canary alarm points at a (MetricName, Dimensions-shape) tuple the handler actually emits', async () => {
    const alarms = loadCanaryAlarms();
    // Sanity: if this drops to zero, the parser broke and the test is a no-op.
    expect(alarms.length).toBeGreaterThan(0);

    await handler();
    const published = getPublishedMetrics();
    const emittedShapes = new Set(
      published.map((d) => {
        const names = (d.Dimensions ?? []).map((dim) => dim.Name).sort();
        return `${d.MetricName}|${names.join(',')}`;
      })
    );

    for (const alarm of alarms) {
      const shape = `${alarm.metricName}|${[...alarm.dimensionNames].sort().join(',')}`;
      expect(
        emittedShapes,
        `alarm ${alarm.alarmName} (${alarm.resourceName}) targets ${alarm.namespace}/${alarm.metricName} with dimensions [${alarm.dimensionNames.join(', ')}], but publishMetrics never emits that shape. Emitted shapes: ${[...emittedShapes].sort().join('; ')}.`
      ).toContain(shape);
    }
  });
});

/**
 * Method-aware sequential fetch mock for the v1 write canary. The existing
 * `setUpFetchMock` matches by URL substring only, which collides on
 * `/flowsheet` POST vs DELETE vs GET. Method matching is essential here:
 * the enrichment check fires all four against the same path within seconds
 * and a wrong-method dispatch would silently route a DELETE to the GET
 * mock and the row would never be cleaned up.
 *
 * Each route's `responses` array is consumed in order; after the queue
 * exhausts, the last response repeats — so `[notFound, enriched]` means
 * "first poll returns 404, every subsequent poll returns the enriched
 * row." Returns `{ fetchMock, calls }` so a test can verify e.g. that
 * cleanup-DELETE was called even when polling timed out.
 */
type RouteResponse = { status: number; body: unknown };
type Route = { method: string; pattern: string; responses: RouteResponse[] };

function setUpMethodAwareMock(routes: Route[]): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    for (const route of routes) {
      if (method === route.method.toUpperCase() && url.includes(route.pattern)) {
        const key = `${route.method.toUpperCase()} ${route.pattern}`;
        const idx = calls[key] ?? 0;
        calls[key] = idx + 1;
        const resp = route.responses[Math.min(idx, route.responses.length - 1)];
        return new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(`unmatched ${method} ${url}`, { status: 599 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

const SENTINEL_ROW_ID = 42;
const ENRICHED_SENTINEL_ROW = {
  id: SENTINEL_ROW_ID,
  entry_type: 'track',
  artist_name: 'WXYCCanary-1234',
  album_title: 'WXYCCanary',
  track_title: 'Sentinel-1234',
  youtube_music_url: 'https://music.youtube.com/search?q=WXYCCanary-1234',
};

/**
 * Happy-path mock: every check passes, every metric the alarms care about
 * is emitted. Used by the contract test and any test that wants the full
 * outcome shape. The enrichment-quality flow returns one not-found poll
 * (to exercise the 404 retry) followed by an enriched row.
 */
function setUpEnrichmentHappyPathMock(): ReturnType<typeof setUpMethodAwareMock> {
  return setUpMethodAwareMock([
    // Read-side checks (other 6 checks).
    { method: 'GET', pattern: '/healthcheck', responses: [{ status: 200, body: { ok: true } }] },
    { method: 'GET', pattern: '/proxy/library/search', responses: [{ status: 200, body: proxyLibrarySearchResponse }] },
    {
      method: 'GET',
      pattern: '/graph/artists/search',
      responses: [{ status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } }],
    },
    { method: 'GET', pattern: '/library/?artist_name=', responses: [{ status: 200, body: stereolabSearchResults }] },
    { method: 'GET', pattern: '/library/rotation', responses: [{ status: 200, body: [] }] },
    // Sign-in (POST) + token exchange (GET).
    {
      method: 'POST',
      pattern: '/sign-in/email',
      responses: [{ status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } }],
    },
    { method: 'GET', pattern: '/token', responses: [{ status: 200, body: { token: 'fake-jwt' } }] },
    // Write-canary path. Order matters when patterns overlap (`/flowsheet`
    // is a prefix of `/flowsheet/join`), but method-aware matching disambiguates.
    { method: 'GET', pattern: '/flowsheet/djs-on-air', responses: [{ status: 200, body: [] }] },
    {
      method: 'POST',
      pattern: '/flowsheet/join',
      responses: [{ status: 200, body: { id: 99, primary_dj_id: 'canary-user-id' } }],
    },
    { method: 'POST', pattern: '/flowsheet/end', responses: [{ status: 200, body: { id: 99, end_time: 12345 } }] },
    {
      method: 'POST',
      pattern: '/flowsheet',
      responses: [{ status: 201, body: { id: SENTINEL_ROW_ID, show_id: 99 } }],
    },
    // Range poll — what the enrichment check polls until the row's
    // youtube_music_url populates. Distinct pattern (`?start_id=`) so it
    // doesn't shadow `dj-flowsheet-read`'s `?n=5` call.
    {
      method: 'GET',
      pattern: '/flowsheet?start_id=',
      responses: [
        // First range poll: row not yet visible (BS commits async).
        { status: 404, body: { message: 'No Tracks found' } },
        // Subsequent polls: enriched.
        { status: 200, body: [ENRICHED_SENTINEL_ROW] },
      ],
    },
    // dj-flowsheet-read.
    { method: 'GET', pattern: '/flowsheet?n=', responses: [{ status: 200, body: [] }] },
    // Fallback for any other bare-`/flowsheet` GET that might appear.
    { method: 'GET', pattern: '/flowsheet', responses: [{ status: 200, body: [] }] },
    { method: 'DELETE', pattern: '/flowsheet', responses: [{ status: 200, body: ENRICHED_SENTINEL_ROW }] },
  ]);
}

/**
 * Enrichment-quality (write canary v1) — the check the 2026-05-13 LML
 * regression would have caught. Pins:
 *   - Happy path passes and emits `EnrichmentLagSeconds`.
 *   - Skip when another DJ is on-air (no inserts, no metric).
 *   - Skip when `enableWriteProbe` is false.
 *   - Polling timeout fails fast (within budget) AND cleans up the row.
 *   - Insert 5xx propagates as fail without attempting delete.
 */
describe('enrichment-quality write canary', () => {
  const writeProbeConfig: CanaryConfig = {
    backendUrl: 'https://api.example.test',
    authUrl: 'https://auth.example.test',
    semanticIndexUrl: 'https://explore.example.test',
    djEmail: 'canary@wxyc.org',
    djPassword: 'pw',
    enableWriteProbe: true,
    enrichmentPollIntervalMs: 5,
    enrichmentPollTimeoutMs: 500,
    publishMetrics: false,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes and emits EnrichmentLagSeconds on the happy path', async () => {
    setUpEnrichmentHappyPathMock();

    const outcomes = await runCanary(writeProbeConfig);
    const enrichment = outcomes.find((o) => o.name === 'enrichment-quality')!;

    expect(enrichment.status).toBe('pass');
    expect(enrichment.metrics?.EnrichmentLagSeconds).toBeTypeOf('number');
    expect(enrichment.metrics?.EnrichmentLagSeconds).toBeGreaterThanOrEqual(0);
    // Sanity: the lag must be under the test poll budget; otherwise the
    // check returned a value but ran the full timeout — that would mean
    // the loop's "break on success" branch never fired.
    expect(enrichment.metrics?.EnrichmentLagSeconds).toBeLessThan(1);
  });

  it('downgrades to skipped when CANARY_ENABLE_WRITE_PROBE is false (no fetch to write endpoints)', async () => {
    const { fetchMock } = setUpEnrichmentHappyPathMock();

    const outcomes = await runCanary({ ...writeProbeConfig, enableWriteProbe: false });
    const enrichment = outcomes.find((o) => o.name === 'enrichment-quality')!;

    expect(enrichment.status).toBe('skipped');
    expect(enrichment.message).toMatch(/write probe disabled/);
    expect(enrichment.metrics?.EnrichmentLagSeconds).toBeUndefined();

    // No write endpoints called.
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((u) => u.includes('/flowsheet/join'))).toBe(false);
    expect(calls.some((u) => u.includes('/flowsheet/end'))).toBe(false);
  });

  it('skips with a meaningful reason when another DJ is on-air', async () => {
    const { fetchMock } = setUpMethodAwareMock([
      { method: 'GET', pattern: '/healthcheck', responses: [{ status: 200, body: { ok: true } }] },
      {
        method: 'GET',
        pattern: '/proxy/library/search',
        responses: [{ status: 200, body: proxyLibrarySearchResponse }],
      },
      {
        method: 'GET',
        pattern: '/graph/artists/search',
        responses: [{ status: 200, body: { results: [{ id: 1 }] } }],
      },
      { method: 'GET', pattern: '/library/?artist_name=', responses: [{ status: 200, body: stereolabSearchResults }] },
      { method: 'GET', pattern: '/library/rotation', responses: [{ status: 200, body: [] }] },
      {
        method: 'POST',
        pattern: '/sign-in/email',
        responses: [{ status: 200, body: { token: 's', user: { id: 'canary-user-id' } } }],
      },
      { method: 'GET', pattern: '/token', responses: [{ status: 200, body: { token: 'jwt' } }] },
      // Real DJ on-air, NOT the canary user.
      {
        method: 'GET',
        pattern: '/flowsheet/djs-on-air',
        responses: [{ status: 200, body: [{ id: 'real-dj-id', dj_name: 'Real DJ' }] }],
      },
      { method: 'GET', pattern: '/flowsheet', responses: [{ status: 200, body: [] }] },
    ]);

    const outcomes = await runCanary(writeProbeConfig);
    const enrichment = outcomes.find((o) => o.name === 'enrichment-quality')!;

    expect(enrichment.status).toBe('skipped');
    expect(enrichment.message).toMatch(/other DJ on-air/);

    // Critical: no insert was attempted into the real DJ's show.
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    }));
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/flowsheet/join'))).toBe(false);
    const flowsheetPosts = calls.filter((c) => c.method === 'POST' && /\/flowsheet(\?|$)/.test(c.url));
    expect(flowsheetPosts).toHaveLength(0);
  });

  it('fails on insert error WITHOUT attempting cleanup (no row was created)', async () => {
    const { fetchMock } = setUpMethodAwareMock([
      { method: 'GET', pattern: '/healthcheck', responses: [{ status: 200, body: { ok: true } }] },
      {
        method: 'GET',
        pattern: '/proxy/library/search',
        responses: [{ status: 200, body: proxyLibrarySearchResponse }],
      },
      {
        method: 'GET',
        pattern: '/graph/artists/search',
        responses: [{ status: 200, body: { results: [{ id: 1 }] } }],
      },
      { method: 'GET', pattern: '/library/?artist_name=', responses: [{ status: 200, body: stereolabSearchResults }] },
      { method: 'GET', pattern: '/library/rotation', responses: [{ status: 200, body: [] }] },
      {
        method: 'POST',
        pattern: '/sign-in/email',
        responses: [{ status: 200, body: { token: 's', user: { id: 'canary-user-id' } } }],
      },
      { method: 'GET', pattern: '/token', responses: [{ status: 200, body: { token: 'jwt' } }] },
      { method: 'GET', pattern: '/flowsheet/djs-on-air', responses: [{ status: 200, body: [] }] },
      { method: 'POST', pattern: '/flowsheet/join', responses: [{ status: 200, body: { id: 99 } }] },
      { method: 'POST', pattern: '/flowsheet/end', responses: [{ status: 200, body: { id: 99 } }] },
      {
        method: 'POST',
        pattern: '/flowsheet',
        responses: [{ status: 500, body: { message: 'play_order index lookup failed' } }],
      },
      { method: 'GET', pattern: '/flowsheet', responses: [{ status: 200, body: [] }] },
      { method: 'DELETE', pattern: '/flowsheet', responses: [{ status: 200, body: {} }] },
    ]);

    const outcomes = await runCanary(writeProbeConfig);
    const enrichment = outcomes.find((o) => o.name === 'enrichment-quality')!;

    expect(enrichment.status).toBe('fail');
    expect(enrichment.message).toMatch(/insert failed with 500/);

    // No DELETE — there's no row to clean up.
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('fails on polling timeout AND still cleans up the row and ends the show', async () => {
    const { fetchMock } = setUpMethodAwareMock([
      { method: 'GET', pattern: '/healthcheck', responses: [{ status: 200, body: { ok: true } }] },
      {
        method: 'GET',
        pattern: '/proxy/library/search',
        responses: [{ status: 200, body: proxyLibrarySearchResponse }],
      },
      {
        method: 'GET',
        pattern: '/graph/artists/search',
        responses: [{ status: 200, body: { results: [{ id: 1 }] } }],
      },
      { method: 'GET', pattern: '/library/?artist_name=', responses: [{ status: 200, body: stereolabSearchResults }] },
      { method: 'GET', pattern: '/library/rotation', responses: [{ status: 200, body: [] }] },
      {
        method: 'POST',
        pattern: '/sign-in/email',
        responses: [{ status: 200, body: { token: 's', user: { id: 'canary-user-id' } } }],
      },
      { method: 'GET', pattern: '/token', responses: [{ status: 200, body: { token: 'jwt' } }] },
      { method: 'GET', pattern: '/flowsheet/djs-on-air', responses: [{ status: 200, body: [] }] },
      { method: 'POST', pattern: '/flowsheet/join', responses: [{ status: 200, body: { id: 99 } }] },
      { method: 'POST', pattern: '/flowsheet/end', responses: [{ status: 200, body: { id: 99 } }] },
      {
        method: 'POST',
        pattern: '/flowsheet',
        responses: [{ status: 201, body: { id: SENTINEL_ROW_ID } }],
      },
      {
        method: 'GET',
        pattern: '/flowsheet?start_id=',
        // Poll forever returns the row but with null youtube_music_url —
        // this is the 2026-05-13 regression shape exactly.
        responses: [{ status: 200, body: [{ ...ENRICHED_SENTINEL_ROW, youtube_music_url: null }] }],
      },
      { method: 'GET', pattern: '/flowsheet?n=', responses: [{ status: 200, body: [] }] },
      { method: 'GET', pattern: '/flowsheet', responses: [{ status: 200, body: [] }] },
      { method: 'DELETE', pattern: '/flowsheet', responses: [{ status: 200, body: ENRICHED_SENTINEL_ROW }] },
    ]);

    // Tighter timeout so the test runs in well under 1s.
    const outcomes = await runCanary({ ...writeProbeConfig, enrichmentPollTimeoutMs: 80, enrichmentPollIntervalMs: 5 });
    const enrichment = outcomes.find((o) => o.name === 'enrichment-quality')!;

    expect(enrichment.status).toBe('fail');
    expect(enrichment.message).toMatch(/did not populate youtube_music_url/);

    // Cleanup must have run despite the failure — DELETE + end-show called.
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
      body: (init as RequestInit | undefined)?.body,
    }));
    const deleteCall = calls.find((c) => c.method === 'DELETE' && c.url.includes('/flowsheet'));
    expect(deleteCall).toBeDefined();
    // The DELETE body must carry the actual inserted row's id so cleanup
    // hits the right row. Body shape: { entry_id: <number> }.
    expect(deleteCall!.body).toBeTypeOf('string');
    expect(JSON.parse(deleteCall!.body as string)).toMatchObject({ entry_id: SENTINEL_ROW_ID });
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/flowsheet/end'))).toBe(true);
  });

  it('passes with EnrichmentLagSeconds above threshold when enrichment is slow but completes before timeout (SLO-violation but functional)', async () => {
    // This is the primary failure-mode the alarm guards against: enrichment
    // completes (so the check still passes) but takes long enough to
    // breach the SLO threshold. The alarm trips on the metric value, not
    // the check status — there's no test in the suite that pins this
    // independently of the timeout path.
    const nullPoll = { status: 200, body: [{ ...ENRICHED_SENTINEL_ROW, youtube_music_url: null }] };
    setUpMethodAwareMock([
      { method: 'GET', pattern: '/healthcheck', responses: [{ status: 200, body: { ok: true } }] },
      {
        method: 'GET',
        pattern: '/proxy/library/search',
        responses: [{ status: 200, body: proxyLibrarySearchResponse }],
      },
      {
        method: 'GET',
        pattern: '/graph/artists/search',
        responses: [{ status: 200, body: { results: [{ id: 1 }] } }],
      },
      { method: 'GET', pattern: '/library/?artist_name=', responses: [{ status: 200, body: stereolabSearchResults }] },
      { method: 'GET', pattern: '/library/rotation', responses: [{ status: 200, body: [] }] },
      {
        method: 'POST',
        pattern: '/sign-in/email',
        responses: [{ status: 200, body: { token: 's', user: { id: 'canary-user-id' } } }],
      },
      { method: 'GET', pattern: '/token', responses: [{ status: 200, body: { token: 'jwt' } }] },
      { method: 'GET', pattern: '/flowsheet/djs-on-air', responses: [{ status: 200, body: [] }] },
      { method: 'POST', pattern: '/flowsheet/join', responses: [{ status: 200, body: { id: 99 } }] },
      { method: 'POST', pattern: '/flowsheet/end', responses: [{ status: 200, body: { id: 99 } }] },
      {
        method: 'POST',
        pattern: '/flowsheet',
        responses: [{ status: 201, body: { id: SENTINEL_ROW_ID } }],
      },
      {
        method: 'GET',
        pattern: '/flowsheet?start_id=',
        // First 4 polls report a null youtube_music_url, then the 5th
        // returns the enriched row. The mock dispenses responses
        // sequentially and the last entry sticks for any extras.
        responses: [nullPoll, nullPoll, nullPoll, nullPoll, { status: 200, body: [ENRICHED_SENTINEL_ROW] }],
      },
      { method: 'GET', pattern: '/flowsheet?n=', responses: [{ status: 200, body: [] }] },
      { method: 'GET', pattern: '/flowsheet', responses: [{ status: 200, body: [] }] },
      { method: 'DELETE', pattern: '/flowsheet', responses: [{ status: 200, body: ENRICHED_SENTINEL_ROW }] },
    ]);

    // Poll interval 20ms × 5 polls ≈ 100ms of lag. Threshold is enforced
    // by the CloudWatch alarm, not the check; the check passes because
    // enrichment did populate before the 500ms timeout.
    const outcomes = await runCanary({
      ...writeProbeConfig,
      enrichmentPollTimeoutMs: 500,
      enrichmentPollIntervalMs: 20,
    });
    const enrichment = outcomes.find((o) => o.name === 'enrichment-quality')!;

    expect(enrichment.status).toBe('pass');
    // ≥80ms of poll delay (4 sleeps of 20ms before the 5th poll wins);
    // the metric should reflect the multi-poll lag rather than the
    // single-poll happy-path number.
    expect(enrichment.metrics?.EnrichmentLagSeconds).toBeGreaterThanOrEqual(0.07);
  });

  it('publishMetrics emits EnrichmentLagSeconds dimensioned + dimensionless on pass', async () => {
    cloudWatchSendMock.mockClear();
    process.env.CANARY_BACKEND_URL = 'https://api.example.test';
    process.env.CANARY_AUTH_URL = 'https://auth.example.test';
    process.env.CANARY_SEMANTIC_INDEX_URL = 'https://explore.example.test';
    process.env.CANARY_PUBLISH_METRICS = 'true';
    process.env.CANARY_DJ_EMAIL = 'canary@wxyc.org';
    process.env.CANARY_DJ_PASSWORD = 'pw';
    process.env.CANARY_ENABLE_WRITE_PROBE = 'true';
    process.env.CANARY_ENRICHMENT_POLL_INTERVAL_MS = '5';
    process.env.CANARY_ENRICHMENT_POLL_TIMEOUT_MS = '500';
    try {
      setUpEnrichmentHappyPathMock();
      await handler();

      const metricData = getPublishedMetrics();
      const lagMetrics = metricData.filter((d) => d.MetricName === 'EnrichmentLagSeconds');
      const dimensioned = lagMetrics.filter((d) => d.Dimensions && d.Dimensions.length > 0);
      const dimensionless = lagMetrics.filter((d) => !d.Dimensions || d.Dimensions.length === 0);

      // The dimensionless emit is what `wxyc-canary-enrichment-lag`
      // targets. A regression that emitted only the dimensioned variant
      // would leave the alarm at INSUFFICIENT_DATA forever (the
      // wxyc-canary#13 lesson, generalized).
      expect(dimensioned).toHaveLength(1);
      expect(dimensionless).toHaveLength(1);
      expect(dimensioned[0]!.Dimensions![0]!).toEqual({ Name: 'Check', Value: 'enrichment-quality' });
      expect(dimensioned[0]!.Value).toBe(dimensionless[0]!.Value);
      expect(dimensioned[0]!.Value).toBeGreaterThanOrEqual(0);
    } finally {
      delete process.env.CANARY_BACKEND_URL;
      delete process.env.CANARY_AUTH_URL;
      delete process.env.CANARY_SEMANTIC_INDEX_URL;
      delete process.env.CANARY_PUBLISH_METRICS;
      delete process.env.CANARY_DJ_EMAIL;
      delete process.env.CANARY_DJ_PASSWORD;
      delete process.env.CANARY_ENABLE_WRITE_PROBE;
      delete process.env.CANARY_ENRICHMENT_POLL_INTERVAL_MS;
      delete process.env.CANARY_ENRICHMENT_POLL_TIMEOUT_MS;
    }
  });

  it('publishMetrics does NOT emit EnrichmentLagSeconds when the check is skipped or failed', async () => {
    // Skipped path: no DJ credentials → enrichment-quality skips for two
    // reasons (no creds AND write probe off by default). Either way, no
    // value was measured — the alarm series should stay quiet.
    cloudWatchSendMock.mockClear();
    process.env.CANARY_BACKEND_URL = 'https://api.example.test';
    process.env.CANARY_AUTH_URL = 'https://auth.example.test';
    process.env.CANARY_SEMANTIC_INDEX_URL = 'https://explore.example.test';
    process.env.CANARY_PUBLISH_METRICS = 'true';
    delete process.env.CANARY_DJ_EMAIL;
    delete process.env.CANARY_DJ_PASSWORD;
    delete process.env.CANARY_DJ_SECRET_ARN;
    delete process.env.CANARY_ENABLE_WRITE_PROBE;
    try {
      setUpFetchMock({
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
      });
      await handler();
      const metricData = getPublishedMetrics();
      expect(metricData.filter((d) => d.MetricName === 'EnrichmentLagSeconds')).toHaveLength(0);
    } finally {
      delete process.env.CANARY_BACKEND_URL;
      delete process.env.CANARY_AUTH_URL;
      delete process.env.CANARY_SEMANTIC_INDEX_URL;
      delete process.env.CANARY_PUBLISH_METRICS;
    }
  });
});

/**
 * Handler ↔ GitHub-issues reporter dispatch. The reporter itself is covered
 * end-to-end in test/github-issues.test.ts; here we only assert that the
 * handler resolves the PAT from SSM, calls the reporter with the right
 * config, skips the reporter when env is unset, and survives reporter
 * throws — same non-fatal contract publishMetrics has.
 */
describe('handler — GitHub issue reporting dispatch', () => {
  beforeEach(() => {
    ssmSendMock.mockClear();
    reportOutcomesToGitHubMock.mockClear();
    process.env.CANARY_BACKEND_URL = 'https://api.example.test';
    process.env.CANARY_AUTH_URL = 'https://auth.example.test';
    process.env.CANARY_SEMANTIC_INDEX_URL = 'https://explore.example.test';
    process.env.CANARY_PUBLISH_METRICS = 'false';
    delete process.env.CANARY_DJ_EMAIL;
    delete process.env.CANARY_DJ_PASSWORD;
    delete process.env.CANARY_DJ_SECRET_ARN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CANARY_BACKEND_URL;
    delete process.env.CANARY_AUTH_URL;
    delete process.env.CANARY_SEMANTIC_INDEX_URL;
    delete process.env.CANARY_PUBLISH_METRICS;
    delete process.env.CANARY_GITHUB_TOKEN_SSM_PARAM;
    delete process.env.CANARY_GITHUB_ISSUES_REPO;
  });

  it('fetches the SSM PAT and invokes the reporter when both env vars are set', async () => {
    process.env.CANARY_GITHUB_TOKEN_SSM_PARAM = '/wxyc-canary/github-token';
    process.env.CANARY_GITHUB_ISSUES_REPO = 'WXYC/wxyc-canary';
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
    });

    await handler();

    expect(ssmSendMock).toHaveBeenCalledTimes(1);
    const ssmInput = (ssmSendMock.mock.calls[0] as unknown as [{ input: { Name: string; WithDecryption: boolean } }])[0]
      .input;
    expect(ssmInput.Name).toBe('/wxyc-canary/github-token');
    expect(ssmInput.WithDecryption).toBe(true);

    expect(reportOutcomesToGitHubMock).toHaveBeenCalledTimes(1);
    const [reportedOutcomes, reportedConfig] = reportOutcomesToGitHubMock.mock.calls[0] as unknown as [
      Array<{ name: string }>,
      { token: string; repo: string },
    ];
    expect(reportedOutcomes.length).toBeGreaterThan(0);
    expect(reportedConfig).toEqual({ token: 'fake-pat', repo: 'WXYC/wxyc-canary' });
  });

  it('does not fetch SSM or call the reporter when CANARY_GITHUB_TOKEN_SSM_PARAM is unset', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
    });

    await handler();

    expect(ssmSendMock).not.toHaveBeenCalled();
    expect(reportOutcomesToGitHubMock).not.toHaveBeenCalled();
  });

  it('survives a reporter throw — still surfaces canary-failed (not reporter-induced) when a check failed', async () => {
    process.env.CANARY_GITHUB_TOKEN_SSM_PARAM = '/wxyc-canary/github-token';
    process.env.CANARY_GITHUB_ISSUES_REPO = 'WXYC/wxyc-canary';
    reportOutcomesToGitHubMock.mockRejectedValueOnce(new Error('github API rate limited'));
    setUpFetchMock({
      '/healthcheck': { status: 500, body: { error: 'oops' } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
    });

    await expect(handler()).rejects.toThrow(/canary failed/);
    // The reporter throw must not surface as the handler's error — pin that.
    await expect(handler()).rejects.not.toThrow(/github API rate limited/);
  });
});
