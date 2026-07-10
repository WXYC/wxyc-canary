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

/**
 * A single stub entry: either a static `{status, body, headers?}` (the
 * historic shape) OR a `dynamic` function that receives the request URL
 * and returns the response shape. The dynamic form is what
 * `AUTHORIZE_ECHO_STATE_STUB` uses — the `state=` query param is per-tick
 * random, so a static Location can't echo it.
 */
type StubEntry =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | {
      dynamic: (url: string) => { status: number; body: unknown; headers?: Record<string, string> };
    };

/**
 * Reusable stub for the OIDC `/oauth2/authorize` endpoint that mimics a
 * happy 302: echoes the per-tick random `state` back in the Location
 * header and stubs a `code=canned-code` so the check's post-check
 * parity assertion holds. Every DJ-credentialed test that doesn't
 * explicitly care about oidc-authorize's outcome should stitch this
 * into its `setUpFetchMock` responses under the `/oauth2/authorize`
 * key — the fallback used to synthesize this silently, which masked
 * every oidc-authorize regression in the DJ-credentialed test suite
 * (R2-F2). The stub lives here so tests share ONE dispatcher shape.
 */
const AUTHORIZE_ECHO_STATE_STUB: StubEntry = {
  dynamic: (url: string) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    return {
      status: 302,
      body: '',
      headers: {
        Location: `https://canary.wxyc.org/authorize-echo?code=canned-code&state=${encodeURIComponent(state)}`,
      },
    };
  },
};

function setUpFetchMock(responses: Record<string, StubEntry>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const [pattern, resp] of Object.entries(responses)) {
      if (urlString.includes(pattern)) {
        const materialized = 'dynamic' in resp ? resp.dynamic(urlString) : resp;
        return new Response(
          typeof materialized.body === 'string' ? materialized.body : JSON.stringify(materialized.body),
          {
            status: materialized.status,
            headers: { 'Content-Type': 'application/json', ...(materialized.headers ?? {}) },
          }
        );
      }
    }
    // Explicit fail for the OIDC probe endpoint. Historically a silent
    // canned 302 fallback lived here (R2-F2), which meant DJ-credentialed
    // tests that never explicitly stubbed `/oauth2/authorize` synthesized
    // a happy pass — masking any future oidc-authorize regression
    // (dropped `redirect: manual`, broken URL construction, throw in
    // `run`) in those tests' outcome lists. Every DJ-credentialed test
    // must now either stitch `AUTHORIZE_ECHO_STATE_STUB` into its
    // responses or explicitly own the `fail` outcome. Every other
    // unstubbed URL still returns 599 for the same reason.
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
      // `semantic-index-freshness` polls `/health`; fresh + above-floor so it
      // passes. Keyed on the host-qualified path (`explore.example.test/health`)
      // so the substring match can't be shadowed by the backend `/healthcheck`
      // mock — `setUpFetchMock` matches on `includes`, and `/healthcheck` does
      // not contain `explore.example.test/health`.
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the 3 truly-anonymous checks and skips the 9 conditional checks when no credentials are configured', async () => {
    const outcomes = await runCanary(baseConfig);

    expect(outcomes).toHaveLength(12);
    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    expect(byName['backend-healthcheck'].status).toBe('pass');
    expect(byName['semantic-index-search'].status).toBe('pass');
    expect(byName['semantic-index-freshness'].status).toBe('pass');
    expect(byName['proxy-library-search'].status).toBe('skipped');
    expect(byName['dj-library-search'].status).toBe('skipped');
    expect(byName['dj-flowsheet-read'].status).toBe('skipped');
    expect(byName['dj-rotation'].status).toBe('skipped');
    expect(byName['dj-rotation-picker'].status).toBe('skipped');
    expect(byName['enrichment-quality'].status).toBe('skipped');
    // `oidc-authorize` requiresAuth: true. Skips with the standard no-DJ-
    // credentials message so it matches the other DJ-authed checks.
    expect(byName['oidc-authorize'].status).toBe('skipped');
    // `lml-auth` skips on missing LML_API_KEY (operator gap) — same
    // semantics as DJ credentials but a separate config switch. The
    // `baseConfig` fixture leaves `lmlApiKey` undefined.
    expect(byName['lml-auth'].status).toBe('skipped');
    expect(byName['lml-auth'].message).toMatch(/no LML_API_KEY configured/);
    // `gha-runner-online` skips when no GitHub PAT + runner id are
    // configured (operator gap, mirrors lml-auth/DJ-creds). The probe
    // exists to alarm when the EC2-hosted staging-gate runner stops
    // checking in; the alarm only fires on `fail`, not `skipped`.
    expect(byName['gha-runner-online'].status).toBe('skipped');
    expect(byName['gha-runner-online'].message).toMatch(/no GitHub PAT|no runner id/);
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
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
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
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
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
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
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
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
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
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
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
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
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
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
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
 * `semantic-index-freshness` (semantic-index#348 / wxyc-canary#53) is the
 * external backstop for the silent nightly-sync failure: an OOM kills the
 * rebuild before the atomic DB swap, so nothing reaches Sentry and the serving
 * host keeps answering from a stale (or, in the truncated-build case, empty)
 * graph. The check polls `GET /health` on explore.wxyc.org and fails when the
 * graph is older than 36 h OR `artist_count` is below the 100k floor.
 *
 * These tests MOCK `/health`, so the `graph_db_age_seconds` age path is fully
 * exercised here even though the field is not yet live in prod `/health`
 * (semantic-index#348 adds it). The floor half is testable against the current
 * endpoint, which already returns `artist_count`.
 *
 * The freshness check is `pagesOncall: false` (infra tier) — its tier routing
 * is pinned in the `publishMetrics — tier split` block; here we pin the
 * pass/fail/metric behaviour of the probe itself.
 */
describe('runCanary — semantic-index-freshness check (silent stale-graph backstop)', () => {
  // The check hits `${semanticIndexUrl}/health`; baseConfig points
  // semanticIndexUrl at explore.example.test. The other two anonymous checks
  // need stubs so the run produces the full outcome shape without unrelated
  // 599s shadowing the freshness result.
  function setUpHealthMock(health: { status: number; body: unknown }) {
    return setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': health,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes when the graph is fresh and above the artist_count floor', async () => {
    setUpHealthMock({
      status: 200,
      body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 7_200 },
    });

    const outcomes = await runCanary(baseConfig);
    const fresh = outcomes.find((o) => o.name === 'semantic-index-freshness')!;

    expect(fresh.status).toBe('pass');
    // Fresh + above-floor surfaces the age as a metric for dashboard trend.
    expect(fresh.metrics?.GraphDbAgeSeconds).toBe(7_200);
  });

  it('fails when graph_db_age_seconds exceeds the ~36h limit (silent-stale window)', async () => {
    // 37 h — one missed 09:00 UTC sync. This is the headline failure mode: the
    // 22-day undetected stale-graph window the check exists to surface.
    setUpHealthMock({
      status: 200,
      body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 37 * 60 * 60 },
    });

    const outcomes = await runCanary(baseConfig);
    const fresh = outcomes.find((o) => o.name === 'semantic-index-freshness')!;

    expect(fresh.status).toBe('fail');
    expect(fresh.message).toMatch(/graph_db_age_seconds/);
    expect(fresh.message).toMatch(/36h|129600/);
  });

  it('fails when artist_count is below the 100k floor (empty/truncated build, even if fresh)', async () => {
    // Fresh swap of an empty/truncated DB — the "fresh but green-yet-broken"
    // case the absolute floor exists to catch.
    setUpHealthMock({
      status: 200,
      body: { status: 'healthy', artist_count: 42, graph_db_age_seconds: 60 },
    });

    const outcomes = await runCanary(baseConfig);
    const fresh = outcomes.find((o) => o.name === 'semantic-index-freshness')!;

    expect(fresh.status).toBe('fail');
    expect(fresh.message).toMatch(/artist_count/);
    expect(fresh.message).toMatch(/100000|floor/);
  });

  it('fails when /health returns a non-2xx (semantic-index unhealthy/down)', async () => {
    setUpHealthMock({
      status: 503,
      body: { status: 'unhealthy', detail: 'unable to open database file' },
    });

    const outcomes = await runCanary(baseConfig);
    const fresh = outcomes.find((o) => o.name === 'semantic-index-freshness')!;

    expect(fresh.status).toBe('fail');
    expect(fresh.message).toMatch(/503/);
  });

  it('passes on the pre-#348 prod shape (artist_count present, graph_db_age_seconds absent) without an age metric', async () => {
    // Until semantic-index#348 deploys, prod `/health` carries only
    // `artist_count`. The check must NOT fabricate a stale-graph failure from a
    // missing age field — the floor half is the live signal in the meantime.
    setUpHealthMock({
      status: 200,
      body: { status: 'healthy', artist_count: 136_702 },
    });

    const outcomes = await runCanary(baseConfig);
    const fresh = outcomes.find((o) => o.name === 'semantic-index-freshness')!;

    expect(fresh.status).toBe('pass');
    // No age field → no GraphDbAgeSeconds metric (don't publish a fabricated 0).
    expect(fresh.metrics?.GraphDbAgeSeconds).toBeUndefined();
  });

  it('fails when graph_db_age_seconds is explicitly null (semantic-index#348 "DB file absent" sentinel)', async () => {
    // Post-#348, an explicit null (distinct from the field being absent) is the
    // sentinel for "the serving graph DB file is gone". That is non-green and
    // must fail closed — `null > 36h` is silently false in JS, so without an
    // explicit guard a missing graph would read green on the age axis. (#348
    // emits null only alongside a 503 today, caught above; this pins the
    // contract so it stays fail-closed if null ever surfaces on a 200.)
    setUpHealthMock({
      status: 200,
      body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: null },
    });

    const outcomes = await runCanary(baseConfig);
    const fresh = outcomes.find((o) => o.name === 'semantic-index-freshness')!;

    expect(fresh.status).toBe('fail');
    expect(fresh.message).toMatch(/graph_db_age_seconds is null|absent/);
    // A null age must not be published as a fabricated metric value.
    expect(fresh.metrics?.GraphDbAgeSeconds).toBeUndefined();
  });

  it('fails when artist_count is missing or non-numeric (shape regression)', async () => {
    setUpHealthMock({
      status: 200,
      body: { status: 'healthy' },
    });

    const outcomes = await runCanary(baseConfig);
    const fresh = outcomes.find((o) => o.name === 'semantic-index-freshness')!;

    expect(fresh.status).toBe('fail');
    expect(fresh.message).toMatch(/artist_count/);
  });
});

/**
 * `lml-auth` is the layer-1 mitigation for BS#1094 — silent
 * `LML_API_KEY` rotation drift. It POSTs `/api/v1/lookup` directly to
 * LML with the production bearer. It PAGES only on a definitive auth
 * verdict: good-bearer 401/403 (rotation drift) or known-bad-bearer 200
 * (LML_REQUIRE_AUTH disabled). Anything that leaves the auth state
 * indeterminate — a timeout, a 5xx, a 429, any other non-2xx that isn't a
 * clean auth rejection — returns `skipped`, NOT `fail`: LML
 * availability/latency is already a paging surface via
 * `proxy-library-search` and the dj-* checks, and the cold `/api/v1/lookup`
 * can exceed the 8s budget (wxyc-canary alarm-noise, 2026-06-27). Missing
 * bearer is operator gap → skipped.
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

  it('abstains (skipped) when the known-bad bearer returns neither 200 nor 401/403 (e.g. 500) — indeterminate, not page-worthy', async () => {
    // A 5xx on the known-bad probe is not a clean "auth enabled" (401/403)
    // signal and not the "auth disabled" (200) regression either. The auth
    // verdict is indeterminate, so abstain rather than page — LML health is
    // already covered by proxy-library-search and the dj-* checks.
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 200, body: { results: [], cache_stats: {} } },
      lmlBadBearer: { status: 500, body: { detail: 'Internal Server Error' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('skipped');
    expect(lml.message).toMatch(/known-bad/);
    expect(lml.message).toMatch(/500/);
    expect(lml.message).toMatch(/indeterminate/);
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

  it('abstains (skipped) when LML itself is down (good-bearer 5xx) — availability is covered by other checks, not this auth probe', async () => {
    setUpLmlBearerAwareMock({
      lmlGoodBearer: { status: 503, body: { detail: 'Service Unavailable' } },
      lmlBadBearer: { status: 503, body: { detail: 'Service Unavailable' } },
    });

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    // A 503 says nothing about the bearer — the auth verdict is indeterminate.
    // LML being down is already a paging surface via proxy-library-search /
    // dj-* checks, so this probe abstains rather than double-paging.
    expect(lml.status).toBe('skipped');
    expect(lml.message).not.toMatch(/rotation drift/);
    expect(lml.message).not.toMatch(/auth disabled/);
    expect(lml.message).toMatch(/503/);
    expect(lml.message).toMatch(/indeterminate/);
  });

  it('abstains (skipped) when the good-bearer probe times out — the 2026-06-27 cold-/lookup flap, NOT an auth verdict', async () => {
    // The production incident: the cold `/api/v1/lookup` cascade (Apple Music /
    // Spotify / Discogs fan-out) exceeded the 8s canaryFetch budget, so the
    // good-bearer probe aborted. A timeout says nothing about the bearer, so the
    // check must abstain — not page on-call every other 5-minute cycle.
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/healthcheck')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (urlString.includes('/proxy/library/search'))
        return new Response(JSON.stringify(proxyLibrarySearchResponse), { status: 200 });
      if (urlString.includes('/graph/artists/search'))
        return new Response(JSON.stringify({ results: [{ id: 1 }] }), { status: 200 });
      if (urlString.includes('lml.example.test/api/v1/lookup')) throw abortError;
      return new Response(`unmatched mock for ${urlString}`, { status: 599 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('skipped');
    expect(lml.message).toMatch(/good-bearer/);
    expect(lml.message).toMatch(/timed out/);
    expect(lml.message).toMatch(/indeterminate/);
    expect(lml.message).not.toMatch(/rotation drift/);
  });

  it('abstains (skipped) when the known-bad-bearer probe times out — also indeterminate', async () => {
    // Good probe succeeds (2xx) but the second probe aborts. The try/catch on
    // the bad-bearer fetch is a distinct branch from the good-bearer one; pin
    // it so a future refactor can't drop the catch and re-introduce the flap.
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/healthcheck')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (urlString.includes('/proxy/library/search'))
        return new Response(JSON.stringify(proxyLibrarySearchResponse), { status: 200 });
      if (urlString.includes('/graph/artists/search'))
        return new Response(JSON.stringify({ results: [{ id: 1 }] }), { status: 200 });
      if (urlString.includes('lml.example.test/api/v1/lookup')) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.Authorization ?? headers.authorization ?? '';
        if (auth.includes('wxyc-canary-probe-not-a-real-key')) throw abortError;
        return new Response(JSON.stringify({ results: [], cache_stats: {} }), { status: 200 });
      }
      return new Response(`unmatched mock for ${urlString}`, { status: 599 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await runCanary(lmlAuthConfig);
    const lml = outcomes.find((o) => o.name === 'lml-auth')!;

    expect(lml.status).toBe('skipped');
    expect(lml.message).toMatch(/known-bad-bearer/);
    expect(lml.message).toMatch(/indeterminate/);
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
 * `gha-runner-online` is the liveness probe for the EC2-hosted self-hosted
 * GitHub Actions runner that backs the staging-gate suites (Backend-Service,
 * library-metadata-lookup, dj-site). Wired up as part of WXYC/wiki#80
 * phase 1 acceptance: the bootstrap script and runbook (wxyc-shared#167)
 * stand the runner up; this check is infra-tier (`pagesOncall: false`), so
 * when the runner stops checking in it raises the low-urgency
 * `wxyc-canary-infra-degraded` alarm, not the on-call page.
 *
 * Probe shape: `GET /orgs/{org}/actions/runners/{id}` with a fine-scoped
 * PAT. The API returns `{status: "online" | "offline", busy: bool, ...}`.
 * The check passes on `status === "online"` and fails on anything else.
 *
 * The existing `wxyc-canary-check-failure` alarm (3 evaluations × 5 min,
 * 2 datapoints-to-alarm) gives the spec's "≥10 minutes of `status != online`"
 * window for free — no new alarm needed. Sustained outage breach: ~10 min.
 *
 * Skips with a meaningful reason when no PAT or no runner ID is configured
 * (operator gap, mirrors `lml-auth` and DJ-creds). A PAT-resolution error
 * (Secrets Manager / SSM IAM regression) fails the check rather than
 * skipping — that's a real signal, not a config-gap.
 *
 * URL-substring matches use a synthetic host (`gha.example.test`) so the
 * existing `setUpFetchMock` substring routing doesn't shadow other checks.
 */
describe('runCanary — gha-runner-online check (runner liveness probe, wiki#80 phase 1)', () => {
  const RUNNER_ID = 250;
  const ghaRunnerConfig: CanaryConfig = {
    ...baseConfig,
    ghaRunnerApiBase: 'https://gha.example.test',
    ghaRunnerOrg: 'WXYC',
    ghaRunnerId: RUNNER_ID,
    ghaRunnerToken: 'fake-gha-pat',
  };

  /**
   * Bearer-aware mock for the GH API: routes on the runners endpoint and
   * returns the per-test status payload. The 2 truly-anonymous checks
   * (`backend-healthcheck` + `semantic-index-search`) need their own
   * stubs so the canary run produces the full happy-path-except-runner
   * outcome shape — leaving them on 599 would make this test catch the
   * unrelated anonymous-check failures instead of the runner one.
   */
  function setUpGhaApiMock(opts: { runnerStatus: number; runnerBody: unknown }) {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const respond = (resp: { status: number; body: unknown }) =>
        new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (urlString.includes('/healthcheck')) return respond({ status: 200, body: { ok: true } });
      if (urlString.includes('/graph/artists/search')) return respond({ status: 200, body: { results: [{ id: 1 }] } });
      if (urlString.includes(`gha.example.test/orgs/WXYC/actions/runners/${RUNNER_ID}`)) {
        // Headers contract: Authorization bearer + GH-version header. Captured
        // for assertions in the dedicated test below; routed here so the
        // body/status pin per-test.
        void (init?.headers as Record<string, string> | undefined);
        return respond({ status: opts.runnerStatus, body: opts.runnerBody });
      }
      return new Response(`unmatched mock for ${urlString}`, { status: 599 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes when the runner status is "online"', async () => {
    setUpGhaApiMock({
      runnerStatus: 200,
      runnerBody: {
        id: RUNNER_ID,
        name: 'wxyc-e2e-runner',
        status: 'online',
        busy: false,
        labels: [{ name: 'self-hosted' }, { name: 'e2e-runner' }],
      },
    });

    const outcomes = await runCanary(ghaRunnerConfig);
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;
    expect(runner.status).toBe('pass');
  });

  it('fails with an offline message when the runner status is "offline" (the spec\'s primary failure mode)', async () => {
    setUpGhaApiMock({
      runnerStatus: 200,
      runnerBody: {
        id: RUNNER_ID,
        name: 'wxyc-e2e-runner',
        // The runner has stopped polling GitHub — either the host is down,
        // the systemd unit died, or the network egress to github.com is
        // broken. All three need on-call attention. The alarm window
        // (3 evals × 5 min, 2 to alarm) gives the spec's ≥10 min sustained
        // breach.
        status: 'offline',
        busy: false,
        labels: [{ name: 'self-hosted' }, { name: 'e2e-runner' }],
      },
    });

    const outcomes = await runCanary(ghaRunnerConfig);
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('fail');
    expect(runner.message).toMatch(/offline/);
    expect(runner.message).toMatch(/wxyc-e2e-runner|250/);
  });

  it('fails with a clear message when the runner id no longer exists (404 — runner was replaced without updating the stack param)', async () => {
    // When the operator replaces the EC2 host, the new runner gets a new
    // id and the old one is removed from the org. If the CFN parameter
    // `GhaRunnerId` is not updated to point at the new id, the probe 404s.
    // Distinct failure class from "offline" so the on-call routes to the
    // runbook entry on runner replacement, not "the runner died".
    setUpGhaApiMock({
      runnerStatus: 404,
      runnerBody: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' },
    });

    const outcomes = await runCanary(ghaRunnerConfig);
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('fail');
    expect(runner.message).toMatch(/404|not found/i);
  });

  it('fails with a distinct message when the PAT is revoked or unscoped (401/403)', async () => {
    setUpGhaApiMock({
      runnerStatus: 401,
      runnerBody: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' },
    });

    const outcomes = await runCanary(ghaRunnerConfig);
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('fail');
    // Operator routing: rotate the PAT, not "the runner is down".
    expect(runner.message).toMatch(/401|credentials|PAT/i);
  });

  it('skips when no GitHub PAT is configured (operator gap, not regression)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
    });

    const outcomes = await runCanary({
      ...baseConfig,
      ghaRunnerApiBase: 'https://gha.example.test',
      ghaRunnerOrg: 'WXYC',
      ghaRunnerId: RUNNER_ID,
      // ghaRunnerToken intentionally omitted
    });
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('skipped');
    expect(runner.message).toMatch(/no GitHub PAT/);
  });

  it('skips when no runner id is configured (operator gap)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
    });

    const outcomes = await runCanary({
      ...baseConfig,
      ghaRunnerApiBase: 'https://gha.example.test',
      ghaRunnerOrg: 'WXYC',
      ghaRunnerToken: 'fake-gha-pat',
      // ghaRunnerId intentionally omitted
    });
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('skipped');
    expect(runner.message).toMatch(/no runner id/);
  });

  it('sends the PAT as Authorization: Bearer and targets /orgs/{org}/actions/runners/{id} via GET', async () => {
    const fetchMock = setUpGhaApiMock({
      runnerStatus: 200,
      runnerBody: { id: RUNNER_ID, status: 'online' },
    });

    await runCanary(ghaRunnerConfig);

    const ghaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('gha.example.test'));
    expect(ghaCalls).toHaveLength(1);
    const [url, init] = ghaCalls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gha.example.test/orgs/WXYC/actions/runners/250');
    // The check must use GET. The lml-auth check this one was modeled on uses
    // POST; pin the method so a copy-paste refactor that swaps it doesn't
    // silently start 404'ing in prod with a 'runner was likely replaced' alarm.
    expect(String(init?.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fake-gha-pat');
    // GitHub REST v3 prefers a versioned Accept header; the bare API
    // version header is also recommended for forwards-compat. Pin both so
    // a future GH-API rev that drops support for the unversioned default
    // surfaces here as a test failure rather than a silent 404/406.
    expect(headers.Accept).toMatch(/application\/vnd\.github/);
    expect(headers['X-GitHub-Api-Version']).toBeDefined();
  });

  // Hardening tests addressing review feedback on the initial check shape.
  // Each pins a known footgun the first pass either had or could grow into.

  it('skips when ghaRunnerId is NaN (CANARY_GHA_RUNNER_ID was a non-numeric typo)', async () => {
    // The env loader does `process.env.X ? Number(...) : undefined`. A typo
    // like CANARY_GHA_RUNNER_ID=abc is truthy as a string; Number('abc') → NaN;
    // typeof NaN === 'number'. Without an explicit isFinite/isInteger guard
    // the check would URL-template NaN and 404, then misroute as 'runner was
    // likely replaced'. Skip instead — operator-visible config error.
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
    });

    const outcomes = await runCanary({
      ...baseConfig,
      ghaRunnerApiBase: 'https://gha.example.test',
      ghaRunnerOrg: 'WXYC',
      ghaRunnerToken: 'fake-gha-pat',
      ghaRunnerId: Number.NaN,
    });
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('skipped');
    expect(runner.message).toMatch(/no runner id|invalid runner id/i);
  });

  it('skips when ghaRunnerId is 0 (the CFN-documented disabling sentinel) instead of probing /runners/0', async () => {
    // The template treats GhaRunnerId=0 as the disabling sentinel and strips
    // the env var to empty string. Belt-and-suspenders: the check itself
    // must also treat 0 (and any non-positive integer) as the skip case so
    // non-CFN deploy paths (local invoke, manual env override, future
    // template refactor) cannot bypass the sentinel.
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
    });

    const outcomes = await runCanary({
      ...baseConfig,
      ghaRunnerApiBase: 'https://gha.example.test',
      ghaRunnerOrg: 'WXYC',
      ghaRunnerToken: 'fake-gha-pat',
      ghaRunnerId: 0,
    });
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('skipped');
    expect(runner.message).toMatch(/no runner id|invalid runner id/i);
  });

  it('fails with a distinct "GitHub rate-limited" message when 403 is a rate-limit, not a PAT-rejection', async () => {
    // Primary-rate-limit 403s carry `X-RateLimit-Remaining: 0` and a body
    // mentioning "rate limit". The check must NOT route this to "rotate the
    // runner-liveness PAT" — that wastes operator time on a token that's
    // perfectly valid. Distinct message + 'wait' framing instead.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const respond = (resp: { status: number; body: unknown; headers?: Record<string, string> }) =>
        new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...(resp.headers ?? {}) },
        });
      if (urlString.includes('/healthcheck')) return respond({ status: 200, body: { ok: true } });
      if (urlString.includes('/graph/artists/search')) return respond({ status: 200, body: { results: [{ id: 1 }] } });
      if (urlString.includes(`gha.example.test/orgs/WXYC/actions/runners/${RUNNER_ID}`)) {
        return respond({
          status: 403,
          body: {
            message: 'API rate limit exceeded for user ID 12345.',
            documentation_url: 'https://docs.github.com/rest',
          },
          headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1718000000' },
        });
      }
      return new Response(`unmatched mock for ${urlString}`, { status: 599 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await runCanary(ghaRunnerConfig);
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('fail');
    expect(runner.message).toMatch(/rate limit/i);
    // Must NOT mis-route to the PAT rotation runbook.
    expect(runner.message).not.toMatch(/rotate/i);
  });

  it('fails with a distinct "GitHub degraded" message on 5xx (not the generic !ok branch)', async () => {
    // The docstring on the check promises 5xx routes distinctly so the
    // on-call goes to githubstatus.com, not the runner. Pin the contract.
    setUpGhaApiMock({
      runnerStatus: 503,
      runnerBody: { message: 'Service Unavailable' },
    });

    const outcomes = await runCanary(ghaRunnerConfig);
    const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

    expect(runner.status).toBe('fail');
    expect(runner.message).toMatch(/GitHub.*degraded|githubstatus/i);
    // Must NOT mis-route to the runner-replaced or PAT-rotation runbook.
    expect(runner.message).not.toMatch(/replaced/i);
    expect(runner.message).not.toMatch(/rotate/i);
  });

  it('uses the WXYC default for ghaRunnerOrg when the env value is an empty string (not just undefined)', async () => {
    // `??` only catches nullish; an env-driven empty string for
    // CANARY_GHA_RUNNER_ORG would let '' through and produce `/orgs//actions`.
    // Pin that the default kicks in for both undefined and ''.
    const fetchMock = setUpGhaApiMock({
      runnerStatus: 200,
      runnerBody: { id: RUNNER_ID, status: 'online' },
    });

    await runCanary({
      ...ghaRunnerConfig,
      ghaRunnerOrg: '',
    });

    const ghaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('gha.example.test'));
    expect(ghaCalls).toHaveLength(1);
    const [url] = ghaCalls[0] as unknown as [string];
    expect(url).toBe('https://gha.example.test/orgs/WXYC/actions/runners/250');
  });

  it('does not attempt SSM PAT resolution when no runner id is configured (half-configured probe must not alarm)', async () => {
    // Half-configured-probe defense: a deploy that sets the SSM token param
    // but forgets the runner-id parameter should NOT raise an alarm when SSM
    // glitches transiently. The runner-id is the load-bearing gate; without
    // it the probe wouldn't run anyway, so SSM resolution must be SKIPPED
    // entirely. Pins both the resulting outcome AND that no SSM call was
    // attempted — the latter is the actual contract; the former is the
    // observable consequence.
    ssmSendMock.mockClear();
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1 }] } },
    });
    process.env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM = '/wxyc-canary/gha-runner-token';

    try {
      const outcomes = await runCanary({
        ...baseConfig,
        ghaRunnerApiBase: 'https://gha.example.test',
        ghaRunnerOrg: 'WXYC',
        // ghaRunnerId intentionally omitted (probe not actually enabled)
        // ghaRunnerToken intentionally omitted so resolution path would run
        //   absent the gate
      });
      const runner = outcomes.find((o) => o.name === 'gha-runner-online')!;

      expect(runner.status).toBe('skipped');
      expect(runner.message).toMatch(/no runner id|invalid runner id/i);
      // The actual contract: zero SSM calls when the runner-id is absent.
      expect(ssmSendMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM;
    }
  });

  it('normalizes a trailing slash on ghaRunnerApiBase so the URL has no double slash', async () => {
    // Operator copy-paste hazard. GitHub today tolerates `//`; a path-strict
    // proxy or future GH rev would 404 and misroute as 'runner replaced'.
    const fetchMock = setUpGhaApiMock({
      runnerStatus: 200,
      runnerBody: { id: RUNNER_ID, status: 'online' },
    });

    await runCanary({
      ...ghaRunnerConfig,
      ghaRunnerApiBase: 'https://gha.example.test/',
    });

    const ghaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('gha.example.test'));
    expect(ghaCalls).toHaveLength(1);
    const [url] = ghaCalls[0] as unknown as [string];
    expect(url).toBe('https://gha.example.test/orgs/WXYC/actions/runners/250');
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
 * `CheckFailure` is published twice: once with the `Check` dimension (for
 * dashboards / slicing) and once dimensionless. CloudWatch alarms cannot use
 * `SUM(SEARCH(...))` (issue #13), so emit-twice is how a plain-form alarm
 * reads a metric we also publish dimensioned. Post-#48 the dimensionless
 * `CheckFailure` is a dashboard-only rollup — no alarm reads it; the page
 * reads the `UserFacingCheckFailure` aggregate (covered by the
 * `publishMetrics — tier split` block below). These regressions pin both
 * `CheckFailure` emissions, the failure-case value flow, and the
 * dimensioned-only contract for `CheckSkipped` / `CheckLatency` (alarming on
 * those would be noise).
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
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
    });

    await handler();

    const checkFailureData = getPublishedMetrics().filter((d) => d.MetricName === 'CheckFailure');
    const dimensioned = checkFailureData.filter((d) => d.Dimensions && d.Dimensions.length > 0);
    const dimensionless = checkFailureData.filter((d) => !d.Dimensions || d.Dimensions.length === 0);

    // Twelve checks, each contributes one dimensioned and one dimensionless datapoint.
    expect(dimensioned).toHaveLength(12);
    expect(dimensionless).toHaveLength(12);
    // Without an inducer, every value is 0 (passes + skips).
    expect(dimensioned.every((d) => d.Value === 0)).toBe(true);
    expect(dimensionless.every((d) => d.Value === 0)).toBe(true);
  });

  // Pins that `failureValue` flows into BOTH the dimensioned and dimensionless
  // `CheckFailure` emissions. Post-#48 no alarm reads dimensionless
  // `CheckFailure` (the page reads `UserFacingCheckFailure` — covered by the
  // `publishMetrics — tier split` block below); this still guards the
  // dimensioned-vs-dimensionless value parity the dashboards rely on.
  it('flows the failure value (1) into both the dimensioned and dimensionless emission for the failing check', async () => {
    setUpFetchMock({
      // backend-healthcheck fails; everything else passes (DJ-auth checks
      // skip with no creds — skipped is not a failure).
      '/healthcheck': { status: 500, body: { error: 'oops' } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
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
    expect(dimensionless.filter((d) => d.Value === 0)).toHaveLength(11);
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
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
    });

    await handler();

    const metricData = getPublishedMetrics();
    const isDimensionless = (d: MetricDatum) => !d.Dimensions || d.Dimensions.length === 0;
    expect(metricData.filter((d) => d.MetricName === 'CheckSkipped' && isDimensionless(d))).toHaveLength(0);
    expect(metricData.filter((d) => d.MetricName === 'CheckLatency' && isDimensionless(d))).toHaveLength(0);
    // Sanity: the dimensioned series for each is present (one per check).
    expect(metricData.filter((d) => d.MetricName === 'CheckSkipped')).toHaveLength(12);
    expect(metricData.filter((d) => d.MetricName === 'CheckLatency')).toHaveLength(12);
  });
});

/**
 * Tier split (wxyc-canary#48). The `wxyc-canary-check-failure` page reads
 * the `UserFacingCheckFailure` aggregate; `wxyc-canary-infra-degraded`
 * reads `InfraCheckFailure`. Both are dimensionless-only (per-surface
 * drill-down is already served by the dimensioned `CheckFailure`). Each
 * check contributes exactly one aggregate datum, routed by `pagesOncall`:
 * `gha-runner-online` and `semantic-index-freshness` → `InfraCheckFailure`,
 * everything else → `UserFacingCheckFailure`. The alarms use
 * `Statistic: Maximum`, so the contract these tests pin is "the max of the
 * tier's dimensionless series over the run".
 */
describe('publishMetrics — tier split (UserFacingCheckFailure / InfraCheckFailure)', () => {
  // All aggregate emissions are dimensionless; filter by name and read values.
  const tierMax = (metrics: MetricDatum[], name: string): number => {
    const values = metrics.filter((d) => d.MetricName === name).map((d) => d.Value ?? 0);
    return values.length === 0 ? Number.NaN : Math.max(...values);
  };
  const tierValues = (metrics: MetricDatum[], name: string): number[] =>
    metrics.filter((d) => d.MetricName === name).map((d) => d.Value ?? 0);
  // The dimensioned CheckFailure carries `Check=<name>`, so it tells us
  // *which* check failed without reaching into the handler's log line.
  const dimensionedFailureValue = (metrics: MetricDatum[], checkName: string): number | undefined =>
    metrics.find(
      (d) =>
        d.MetricName === 'CheckFailure' &&
        (d.Dimensions ?? []).some((dim) => dim.Name === 'Check' && dim.Value === checkName)
    )?.Value;

  beforeEach(() => {
    cloudWatchSendMock.mockClear();
    process.env.CANARY_BACKEND_URL = 'https://api.example.test';
    process.env.CANARY_AUTH_URL = 'https://auth.example.test';
    process.env.CANARY_SEMANTIC_INDEX_URL = 'https://explore.example.test';
    process.env.CANARY_PUBLISH_METRICS = 'true';
    delete process.env.CANARY_DJ_EMAIL;
    delete process.env.CANARY_DJ_PASSWORD;
    delete process.env.CANARY_DJ_SECRET_ARN;
    delete process.env.CANARY_GHA_RUNNER_API_BASE;
    delete process.env.CANARY_GHA_RUNNER_ORG;
    delete process.env.CANARY_GHA_RUNNER_ID;
    delete process.env.CANARY_GHA_RUNNER_TOKEN;
    // Defensive: no tier-split test sets this, but clearing it guarantees the
    // runner check resolves its token inline (never via the SSM mock) even if
    // an earlier block leaked it — keeps cloudWatchSendMock the only AWS call.
    delete process.env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CANARY_BACKEND_URL;
    delete process.env.CANARY_AUTH_URL;
    delete process.env.CANARY_SEMANTIC_INDEX_URL;
    delete process.env.CANARY_PUBLISH_METRICS;
    delete process.env.CANARY_DJ_EMAIL;
    delete process.env.CANARY_DJ_PASSWORD;
    delete process.env.CANARY_GHA_RUNNER_API_BASE;
    delete process.env.CANARY_GHA_RUNNER_ORG;
    delete process.env.CANARY_GHA_RUNNER_ID;
    delete process.env.CANARY_GHA_RUNNER_TOKEN;
    delete process.env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM;
  });

  // Replay of the 2026-06-17 22:30 page: the staging-gate runner went
  // offline. Infra failure must NOT trip the user-facing page.
  it('does not page when only gha-runner-online fails (runner offline → InfraCheckFailure, not UserFacingCheckFailure)', async () => {
    process.env.CANARY_GHA_RUNNER_API_BASE = 'https://gha.example.test';
    process.env.CANARY_GHA_RUNNER_ORG = 'WXYC';
    process.env.CANARY_GHA_RUNNER_ID = '250';
    process.env.CANARY_GHA_RUNNER_TOKEN = 'fake-gha-pat';
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      // semantic-index-freshness is also infra-tier; keep it passing so the
      // infra series carries ONLY the runner's failure (the assertion below).
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
      'gha.example.test/orgs/WXYC/actions/runners/250': {
        status: 200,
        body: { id: 250, name: 'wxyc-e2e-runner', status: 'offline' },
      },
    });

    await expect(handler()).rejects.toThrow(/canary failed/);
    const metrics = getPublishedMetrics();

    // The runner check is the failing one…
    expect(dimensionedFailureValue(metrics, 'gha-runner-online')).toBe(1);
    // …but no user-facing check failed → the page series stays flat at 0.
    expect(tierMax(metrics, 'UserFacingCheckFailure')).toBe(0);
    // The infra series carries exactly the runner's failure.
    expect(tierMax(metrics, 'InfraCheckFailure')).toBe(1);
    expect(tierValues(metrics, 'InfraCheckFailure').filter((v) => v === 1)).toHaveLength(1);
  });

  // DP1 (RESOLVED): the nightly ~09:00 UTC explore.wxyc.org blip was an
  // OOM-restart of the in-process rebuild; semantic-index#347 moved the
  // rebuild off-host, so the surface is reliably green again and was restored
  // to the page (wxyc-canary#50). A real /graph/artists/search failure must
  // now trip the user-facing page, not the low-urgency infra alarm.
  it('pages when only semantic-index-search fails (shape regression → UserFacingCheckFailure)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      // Missing `results` envelope — the shape regression the check catches.
      '/graph/artists/search': { status: 200, body: { something_else: [] } },
      // Freshness (infra) stays green so the infra series stays flat — the
      // search failure must land on the user-facing tier alone.
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
    });

    await expect(handler()).rejects.toThrow(/canary failed/);
    const metrics = getPublishedMetrics();

    expect(dimensionedFailureValue(metrics, 'semantic-index-search')).toBe(1);
    expect(tierMax(metrics, 'UserFacingCheckFailure')).toBe(1);
    expect(tierValues(metrics, 'UserFacingCheckFailure').filter((v) => v === 1)).toHaveLength(1);
    expect(tierMax(metrics, 'InfraCheckFailure')).toBe(0);
  });

  // The new silent-stale-graph backstop (semantic-index#348 / wxyc-canary#53)
  // is infra-tier: a stale or empty graph DB must raise the low-urgency infra
  // alarm, never the user-facing page.
  it('does not page when only semantic-index-freshness fails (stale graph → InfraCheckFailure)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      // 37 h stale — one missed nightly sync.
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 37 * 60 * 60 },
      },
    });

    await expect(handler()).rejects.toThrow(/canary failed/);
    const metrics = getPublishedMetrics();

    expect(dimensionedFailureValue(metrics, 'semantic-index-freshness')).toBe(1);
    expect(tierMax(metrics, 'UserFacingCheckFailure')).toBe(0);
    expect(tierMax(metrics, 'InfraCheckFailure')).toBe(1);
    expect(tierValues(metrics, 'InfraCheckFailure').filter((v) => v === 1)).toHaveLength(1);
  });

  // The two untagged-but-user-facing checks must each page on their own.
  // Distinct cases catch a name mix-up or one being commented out; the
  // classification-pin test in checks.test.ts guards the tier assignment.
  it.each([
    {
      name: 'dj-rotation',
      // A non-array rotation body fails dj-rotation (and, as a side effect,
      // the picker's precondition). dj-rotation is the asserted failure.
      mocks: {
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: { not: 'an array' } },
      } as Record<string, StubEntry>,
    },
    {
      name: 'dj-rotation-picker',
      // Rotation list is healthy (dj-rotation passes); the picker's
      // /tracks fetch 502s — the BS#994/#1030 cascade-to-502 class, in
      // isolation.
      mocks: {
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation/4242/tracks': { status: 502, body: { message: 'LML cascade timed out' } },
        '/library/rotation': { status: 200, body: [{ id: 4242 }] },
      } as Record<string, StubEntry>,
    },
  ])('pages when only $name fails (untagged but user-facing)', async ({ name, mocks }) => {
    process.env.CANARY_DJ_EMAIL = 'canary@wxyc.org';
    process.env.CANARY_DJ_PASSWORD = 'pw';
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/oauth2/authorize': AUTHORIZE_ECHO_STATE_STUB,
      ...mocks,
    });

    await expect(handler()).rejects.toThrow(/canary failed/);
    const metrics = getPublishedMetrics();

    // The named check is the one that failed (guards against a name mix-up
    // or the check being commented out of the array).
    expect(dimensionedFailureValue(metrics, name)).toBe(1);
    // The page fires. NOTE the tier guard is the `InfraCheckFailure == 0`
    // assertion, not `UserFacingCheckFailure == 1`: in the dj-rotation case
    // the bad rotation list also fails dj-rotation-picker, so the page could
    // be carried by the picker alone. But the named check IS failing here, so
    // if it were misclassified to `pagesOncall: false` its failure value would
    // land in InfraCheckFailure and trip the line below. Keep both assertions
    // — together they pin that the named check routes to the page tier.
    expect(tierMax(metrics, 'UserFacingCheckFailure')).toBe(1);
    expect(tierMax(metrics, 'InfraCheckFailure')).toBe(0);
  });

  // Replay of the 2026-06-15 / 2026-06-16 7-check blips: a genuine
  // user-facing surface 5xx'd → the page MUST fire.
  it('pages when a user-facing check fails (backend-healthcheck 500 → UserFacingCheckFailure)', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 500, body: { error: 'oops' } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      // Freshness passes so the infra series stays flat — only the user-facing
      // backend check should trip a tier here.
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
    });

    await expect(handler()).rejects.toThrow(/canary failed/);
    const metrics = getPublishedMetrics();

    expect(dimensionedFailureValue(metrics, 'backend-healthcheck')).toBe(1);
    expect(tierMax(metrics, 'UserFacingCheckFailure')).toBe(1);
    // Infra series stays flat — semantic checks pass and the runner check skips.
    expect(tierMax(metrics, 'InfraCheckFailure')).toBe(0);
  });

  // Skip is not a failure on EITHER tier. With no DJ creds / LML key /
  // runner id, the auth + write + runner checks all skip; the aggregate
  // contributions must be 0 (CheckSkipped semantics preserved).
  it('emits 0 on both tiers when every check passes or skips', async () => {
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
    });

    await handler();
    const metrics = getPublishedMetrics();

    // 10 paging checks (9 user-facing + enrichment-quality), 2 infra checks
    // (gha-runner-online, semantic-index-freshness); every aggregate datum is
    // dimensionless and 0.
    expect(tierValues(metrics, 'UserFacingCheckFailure')).toHaveLength(10);
    expect(tierValues(metrics, 'InfraCheckFailure')).toHaveLength(2);
    expect(tierMax(metrics, 'UserFacingCheckFailure')).toBe(0);
    expect(tierMax(metrics, 'InfraCheckFailure')).toBe(0);
    // The aggregates are dimensionless-only — no `Check`-dimensioned twin.
    const aggregates = metrics.filter(
      (d) => d.MetricName === 'UserFacingCheckFailure' || d.MetricName === 'InfraCheckFailure'
    );
    expect(aggregates.every((d) => !d.Dimensions || d.Dimensions.length === 0)).toBe(true);
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
type RouteResponse = { status: number; body: unknown; headers?: Record<string, string> };
// `dynamic` lets a route inspect the incoming URL to build the response —
// needed for the OIDC authorize probe (wxyc-canary#60), whose state-parity
// assertion requires the mock to echo back the state the check just sent.
// A static `responses` queue can't know that state in advance.
type Route = {
  method: string;
  pattern: string;
  responses?: RouteResponse[];
  dynamic?: (url: string, init?: RequestInit) => RouteResponse;
};

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
        const resp = route.dynamic
          ? route.dynamic(url, init)
          : (route.responses ?? [])[Math.min(idx, (route.responses ?? []).length - 1)];
        if (!resp) return new Response(`route without responses/dynamic for ${route.pattern}`, { status: 599 });
        return new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...(resp.headers ?? {}) },
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
    // Read-side checks (other anonymous + DJ checks).
    { method: 'GET', pattern: '/healthcheck', responses: [{ status: 200, body: { ok: true } }] },
    // semantic-index-freshness — fresh + above-floor so it passes. Host-
    // qualified pattern so it can't be shadowed by `/healthcheck`.
    {
      method: 'GET',
      pattern: 'explore.example.test/health',
      responses: [{ status: 200, body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 } }],
    },
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
    // oidc-authorize (wxyc-canary#60). Happy-path 302 back to the probe
    // redirect URI with a fabricated code + the state the check just sent.
    // The check's state-parity assertion requires an echoed state; a static
    // response can't know a per-tick random value in advance, so this
    // route uses a dynamic handler that reads `state=` off the incoming
    // URL and echoes it into the Location header. The dedicated
    // `oidc-authorize` describe block above pins the check's own value-
    // matrix; this stub is what keeps the contract + enrichment tests
    // (which need `UserFacingCheckFailure = 0` from every check to satisfy
    // "canary passed") green now that oidc-authorize joined the checks
    // array.
    {
      method: 'GET',
      pattern: '/oauth2/authorize',
      dynamic: (url) => {
        const parsedUrl = new URL(url);
        const echoedState = parsedUrl.searchParams.get('state') ?? '';
        return {
          status: 302,
          body: '',
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(echoedState)}`,
          },
        };
      },
    },
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
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
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
 * `oidc-authorize` (wxyc-canary#60) — end-to-end probe of the OIDC code +
 * PKCE dance the flowsheet-digitization verifier (and every future OIDC
 * client) rides on. The check exists because WXYC/Backend-Service#1571 —
 * the `oauthConsent` schema-drift 500 — went undetected for months: the
 * initial `/auth/oauth2/authorize` redirect was green, but the return trip
 * (post-login) 500'd on the consent write and only surfaced when the
 * flowsheet verifier tried a real login. The existing canary suite covered
 * healthcheck, DJ bearer, semantic-index, and enrichment writes; nothing
 * walked authorize + code-issue.
 *
 * The probe uses a dedicated `wxyc-canary` PUBLIC trusted client (registered
 * in WXYC/Backend-Service#1576 — this canary check is blocked-by that
 * ticket and MUST NOT deploy before the client exists). Public client +
 * PKCE, so no client secret lives in the canary env. The probe stops at
 * the /authorize 302 without exchanging the code — inspecting the Location
 * header for `code=<non-empty>` + matching `state` is sufficient to prove
 * the whole authorize + consent path executed.
 *
 * These tests MOCK `/oauth2/authorize` to return the exact 500 shape from
 * BS#1571 (asserted to `fail` the check with a message pointing at
 * `oauthConsent` or `authorize`), and separately a valid 302 (asserted to
 * `pass`). The sign-in-429 precondition path is already covered by the
 * generic auth-precondition tests above (the check is `requiresAuth: true`,
 * so any sign-in failure propagates the same way as dj-library-search).
 */
describe('runCanary — oidc-authorize check (wxyc-canary#60)', () => {
  // Helper: build a fetch mock that returns the given `/oauth2/authorize`
  // response (including its raw response headers, notably `Location`) while
  // stubbing every other endpoint enough to let the check reach the
  // authorize call. All other checks pass; only the authorize probe's
  // outcome is under test. The stock `setUpFetchMock` only threads status
  // + body — we need `Location` to flow through so the 302-inspection path
  // is exercised. This helper duplicates enough of `setUpFetchMock`'s
  // dispatch logic to handle that, and defers to the standard stub set
  // for every non-authorize URL.
  function setUpAuthorizeMock(authorize: { status: number; body: unknown; headers?: Record<string, string> }) {
    const stubs: Record<string, { status: number; body: unknown }> = {
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation': { status: 200, body: [] },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        const bodyText = typeof authorize.body === 'string' ? authorize.body : JSON.stringify(authorize.body);
        return new Response(bodyText, {
          status: authorize.status,
          headers: { 'Content-Type': 'application/json', ...(authorize.headers ?? {}) },
        });
      }
      for (const [pattern, resp] of Object.entries(stubs)) {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // R2-F2: the historical `setUpFetchMock` fallback synthesized a canned
  // happy 302 for `/oauth2/authorize` so DJ-credentialed tests that didn't
  // explicitly stub it got a silent pass. That masked oidc-authorize
  // regressions (throw in `run`, dropped `redirect: manual`, broken URL
  // construction) in every DJ-credentialed test that didn't own the check
  // outcome. The fallback is gone — an unstubbed `/oauth2/authorize` now
  // hits the generic 599 branch, which forces the check to fail loudly.
  // This test pins that shape so a future re-introduction of a silent
  // fallback in `setUpFetchMock` regresses this test rather than silently
  // masking every DJ-credentialed test's oidc-authorize outcome.
  it('fails loudly (not silently passes) when a DJ-credentialed test forgets to stub /oauth2/authorize (R2-F2 regression)', async () => {
    // A minimal DJ-credentialed setup that stubs everything BUT
    // `/oauth2/authorize`. The check runs (sign-in succeeds, session token
    // is available) and hits the 599 fallback.
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
      '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'u1' } } },
      '/token': { status: 200, body: { token: 'fake-jwt' } },
      '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
      '/flowsheet': { status: 200, body: [] },
      '/library/rotation': { status: 200, body: [] },
      // Deliberately no `/oauth2/authorize` stub.
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    // The check MUST fail — no silent-pass fallback in the mock harness.
    expect(oidc.status).toBe('fail');
    // The failure message reflects the 599 branch (unmatched mock), which is
    // how the harness makes forgotten stubs visible.
    expect(oidc.message).toMatch(/599|unmatched mock/);
  });

  // `setUpFetchMock` matches by URL substring only; the check needs to
  // consult the `Location` response header. `Response` accepts a `headers`
  // second arg — we thread the Location through the same shape the fetch
  // mock already handles for `Retry-After`.
  it('passes on a valid 302 with code= and matching state on the Location header', async () => {
    // The Location parameter values (`__CODE__` / `__STATE__`) are placeholders
    // the test replaces at call time. Real better-auth-issued codes are a
    // 32-char [a-zA-Z0-9] string (see `generateRandomString(32, ...)` in
    // `oidc-provider/authorize.mjs:104`); anything non-empty proves the
    // check accepted a real code.
    // The check generates a per-tick random `state`; we can't know it here.
    // The mock inspects the outgoing URL and echoes the `state` back in
    // `Location`, so the check's post-check parity assertion holds.
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        // Pin the request shape the check MUST send: response_type=code,
        // client_id=<probe>, scope with openid+profile+email, S256 challenge,
        // Bearer <session-token>. Anything less catches a check-side regression
        // that silently drifts the probe payload.
        const url = new URL(urlString);
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('client_id')).toBe('wxyc-canary');
        expect(url.searchParams.get('redirect_uri')).toBe('https://canary.wxyc.org/authorize-echo');
        const scope = url.searchParams.get('scope') ?? '';
        expect(scope).toMatch(/openid/);
        expect(scope).toMatch(/profile/);
        expect(scope).toMatch(/email/);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        const codeChallenge = url.searchParams.get('code_challenge') ?? '';
        // Base64url alphabet, no padding, 43 chars for a SHA-256 challenge.
        expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const state = url.searchParams.get('state') ?? '';
        expect(state.length).toBeGreaterThan(0);
        // The session token flows through as a bearer — the better-auth
        // `bearer` plugin translates it into the session cookie internally.
        // Never as the DJ JWT (which fails on /oauth2/authorize since JWTs
        // aren't session tokens).
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.Authorization ?? headers.authorization ?? '';
        expect(auth).toBe('Bearer fake-session-token');
        // `redirect: 'manual'` is load-bearing — without it Node's fetch
        // follows the 302 and swallows the Location header. Pin it so a
        // future refactor of the check that drops the init option regresses
        // this test rather than silently masking every 302-shape failure.
        expect(init?.redirect).toBe('manual');
        // Echo the state back to prove the state-parity check works.
        const location = `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(state)}`;
        return new Response(null, {
          status: 302,
          headers: { Location: location },
        });
      }
      // Delegate the other URLs to the standard stubs.
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('pass');
  });

  it('fails on the exact BS#1571 shape — 500 with oauthConsent-not-in-schema BetterAuthError body', async () => {
    // Replay the ticket's failure surface as faithfully as we can:
    // BetterAuthError text mentioning the `oauthConsent` model missing from
    // the schema map. Body shape mirrors better-auth's default 500 JSON.
    setUpAuthorizeMock({
      status: 500,
      body: {
        message:
          'BetterAuthError: [# Drizzle Adapter]: The model "oauthConsent" was not found in the schema object. Please pass the schema directly to the adapter options.',
        code: 'INTERNAL_SERVER_ERROR',
      },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    // The message must include a substring the on-call can grep — either the
    // model name that regressed OR the endpoint that returned it. Both give
    // PagerDuty an actionable pointer without the on-call reading the raw
    // 500 body first.
    expect(oidc.message).toMatch(/oauthConsent|authorize/);
    // Status code MUST land in the message — otherwise the runbook can't
    // disambiguate "500 on authorize" from "302 to a login page" (session
    // rot) at a glance.
    expect(oidc.message).toMatch(/500/);
  });

  it('fails when the auth server 302s back to a login page (session invalidated)', async () => {
    // Sign-in succeeded so /oauth2/authorize was called with a session
    // token, but the auth server treats the session as invalid and bounces
    // to the login page instead of issuing a code. This is the failure mode
    // where the session cookie was accepted by /sign-in but rejected at
    // /oauth2/authorize — real production shape when a session was
    // invalidated between calls or the trusted client is unregistered.
    setUpAuthorizeMock({
      status: 302,
      body: '',
      headers: {
        // The auth server's default login redirect. The check must NOT
        // treat this as a pass just because it's a 302 — the Location must
        // start with the probe's registered redirect URI.
        Location: 'https://dj.wxyc.org/login?client_id=wxyc-canary&code=&state=some-state',
      },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    // Message must point at the login-redirect shape so the on-call routes
    // to session/auth investigation rather than "the trusted client is
    // gone" (they overlap; the message should hint at the bounce).
    expect(oidc.message).toMatch(/login|redirect|Location/i);
  });

  it('fails on a 302 whose Location has no code parameter', async () => {
    setUpAuthorizeMock({
      status: 302,
      body: '',
      headers: { Location: 'https://canary.wxyc.org/authorize-echo?state=some-state' },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    expect(oidc.message).toMatch(/code/i);
  });

  // Regression coverage for R2-F1: a Location whose `code=` sits in the URL
  // fragment (`#code=…`) rather than the query string slips past the
  // origin+pathname compare (fragments live in the URL hash, not the
  // pathname) and past `searchParams.get('code')` (fragments aren't parsed as
  // query). The "no code param" branch fires — and its error message MUST
  // NOT leak the fragment code. Pin the redaction at the sentinel so a
  // future regression that drops the `redactCode` wrap (as landed in R2)
  // fails this test rather than silently exfiltrating the code into the
  // alert.
  it('does not leak the code when it sits in a URL fragment on the Location header (R2-F1 regression)', async () => {
    setUpAuthorizeMock({
      status: 302,
      body: '',
      headers: {
        Location: 'https://canary.wxyc.org/authorize-echo#code=REAL-CODE-FRAG&state=X',
      },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    // The check still routes to the "no code query param" branch, so the
    // message mentions `code`. But the sentinel value must never appear.
    expect(oidc.message).toMatch(/code/i);
    expect(oidc.message).not.toMatch(/REAL-CODE-FRAG/);
  });

  it('fails when the returned state does not match the state the check sent', async () => {
    // State parity is the CSRF barrier. If the server issues a code but the
    // `state` echo differs, either an attacker fixed the state or the
    // authorize handler regressed — both are page-worthy.
    setUpAuthorizeMock({
      status: 302,
      body: '',
      headers: {
        Location: 'https://canary.wxyc.org/authorize-echo?code=abcd1234&state=NOT-THE-STATE-WE-SENT',
      },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    expect(oidc.message).toMatch(/state/i);
  });

  it('fails on a non-302 status even when the body is empty', async () => {
    // Rare but possible: the auth server returns 200 (a JSON body) instead
    // of 302. That's not a valid authorize response for `response_type=code`
    // and must fail. Distinct from the 500 case above (different remediation
    // routing).
    setUpAuthorizeMock({
      status: 200,
      body: '',
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    expect(oidc.message).toMatch(/302|200/);
  });

  it('propagates a terminal sign-in 401 as the auth-precondition failure (invalid credentials, no retry)', async () => {
    // The check is `requiresAuth: true`, so a broken sign-in cascades into
    // the standard auth-precondition-failed path. Distinct from the check-
    // level probe: a sign-in outage shouldn't page as an OIDC regression.
    // A 401 is a terminal shape — signInDj throws immediately (no retry;
    // retries are 429-only). See the "real 429" test below for the
    // transient retry-succeeds path.
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
      '/sign-in/email': { status: 401, body: { error: 'invalid credentials' } },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'wrong' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    expect(oidc.message).toMatch(/auth precondition failed/);
  });

  it('never logs the code or the Set-Cookie header on failure — only status + first 200 chars of body', async () => {
    // The failure message goes straight into the CloudWatch/PagerDuty alert
    // and the GitHub-issue reporter. Leaking a real authorization code is
    // a mid-severity credential exposure (short-lived, single-use, but real);
    // Set-Cookie leaks the session token outright. Pin the redaction.
    //
    // `code=SUPER-SECRET` intentionally lands inside the first 200 chars so
    // the redaction is exercised at the truncated-slice boundary. A body-first
    // redact + slice must strip the token even before the truncation.
    setUpAuthorizeMock({
      status: 500,
      body: 'code=SUPER-SECRET sensitive body prefix, do not leak past 200 chars, and then '.repeat(20),
      headers: { 'Set-Cookie': 'better-auth.session_token=leaked-cookie-value; Path=/; HttpOnly' },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    expect(oidc.message).not.toMatch(/leaked-cookie-value/);
    expect(oidc.message).not.toMatch(/Set-Cookie/i);
    // The literal code value must never appear (even under the "first 200
    // chars" truncation, since it lives in the first ~17 chars of the body).
    // The redaction may substitute a placeholder like `code=<redacted>`,
    // which is fine — pin on the sentinel token itself, not on the pattern
    // shape (a shape-based regex would also match the placeholder).
    expect(oidc.message).not.toMatch(/SUPER-SECRET/);
    // The status suffix is short; 200 chars from a repeated body is capped.
    // The whole "sensitive body" content past the first 200 chars must not
    // land in the alert message.
    expect((oidc.message ?? '').length).toBeLessThan(500);
  });

  // R2-F3: the original redactor was URL-shape only (`/code=[^&\s"']+/g`).
  // Better-auth 5xx envelopes are JSON — a future error envelope that
  // included a minted code as a JSON key would slip through the URL-shape
  // filter. Pin the JSON-shape redaction so the invariant survives that
  // envelope change.
  it('does not leak a code carried as a JSON key on a 5xx response body (R2-F3 regression)', async () => {
    setUpAuthorizeMock({
      status: 500,
      body: { error: 'internal server error', code: 'SUPER-SECRET-JSON' },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    expect(oidc.message).not.toMatch(/SUPER-SECRET-JSON/);
    // Sanity: the 500 status still lands (redaction must not blank the whole
    // body — only the sensitive value).
    expect(oidc.message).toMatch(/500/);
  });

  // R2-F3: `state` gets the same treatment. Line 823 ("state does not match")
  // deliberately prints only the mismatch fact, never the returned value.
  // The sibling error branches (5xx, non-3xx, invalid URL, wrong redirect)
  // must not silently leak state via the raw-body slice — the URL and JSON
  // forms both get redacted.
  it('does not leak state carried in the raw body slice on a 5xx (URL and JSON forms) (R2-F3 regression)', async () => {
    setUpAuthorizeMock({
      status: 500,
      body: {
        error: 'internal server error',
        state: 'SUPER-SECRET-STATE-JSON',
        detail: 'redirected from state=SUPER-SECRET-STATE-URL previously',
      },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    // Neither URL-form nor JSON-form state values must appear in the alert.
    expect(oidc.message).not.toMatch(/SUPER-SECRET-STATE-JSON/);
    expect(oidc.message).not.toMatch(/SUPER-SECRET-STATE-URL/);
  });

  // R3-1: the JSON-shape redactor's terminator class omitted `&`, so on
  // URL-shape input the URL pass would redact `code=`/`state=` first
  // (leaving the placeholder `<redacted>` before the `&`), then the JSON
  // pass matched `code=` again and greedily ate everything to end-of-string
  // (`&` was not a terminator). Result: every diagnostic downstream of
  // `code=` — `scope=openid`, `client_id=probe`, the OIDC `error=`
  // routing signal on fragment-form callbacks — was destroyed. Pin the
  // downstream diagnostics as preserved.
  it('preserves downstream URL query params after redacting code=/state= (R3-1 regression)', async () => {
    // A crafted Location where the redirect origin+path matches (so the
    // guard doesn't fire early), the state matches (so state-mismatch
    // doesn't fire), but the `code=` sits alongside downstream params
    // like `scope` and `client_id`. This exercises no failure path
    // directly — the R3-1 bug is in the redactor invoked by every
    // failure path — so we route through the 500 branch which slices
    // the JSON body and applies the redactor.
    setUpAuthorizeMock({
      status: 500,
      body: 'redirect chain: code=REAL-CODE-VAL&state=REAL-STATE-VAL&scope=openid&client_id=probe&error=access_denied',
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    // Sensitive values still redacted.
    expect(oidc.message).not.toMatch(/REAL-CODE-VAL/);
    expect(oidc.message).not.toMatch(/REAL-STATE-VAL/);
    // Downstream diagnostics MUST survive — under R3-1's buggy JSON pass
    // the greedy match ate everything after `code=<redacted>` in the URL.
    expect(oidc.message).toMatch(/scope=openid/);
    expect(oidc.message).toMatch(/client_id=probe/);
    // The OIDC `error=access_denied` routing signal (fragment-form OIDC
    // failure callbacks carry it) must land in the alert so on-call
    // routes on the failure code.
    expect(oidc.message).toMatch(/error=access_denied/);
  });

  // R3-2: the redactor's `code`/`state` regexes had no word boundary, so
  // any identifier that happened to contain `code` or `state` as a
  // substring — `errorCode`, `statusCode`, `session_state`, and most
  // damagingly `oauthConsent` — had its VALUE redacted (or, in
  // `oauthConsent`'s case, was fine only because the redactor didn't
  // match `oauthConsent` as `code`; the risk is any future
  // `oauthCode`-style breadcrumb). The BS#1571 5xx branch's docstring
  // explicitly promises to preserve the `oauthConsent` model name so
  // on-call can route. Pin all three shapes.
  it('does not redact identifier-adjacent code/state substrings (R3-2 regression)', async () => {
    setUpAuthorizeMock({
      status: 500,
      body: {
        errorCode: 'OAUTH_500',
        statusCode: 500,
        session_state: 'SHOULD-STAY-VISIBLE',
        oauthConsent: 'missing',
        message: 'BetterAuthError: model oauthConsent not in schema',
      },
    });

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    // All three identifier keys and values must survive the redactor.
    expect(oidc.message).toMatch(/errorCode/);
    expect(oidc.message).toMatch(/OAUTH_500/);
    expect(oidc.message).toMatch(/statusCode/);
    expect(oidc.message).toMatch(/500/);
    // The BS#1571 routing breadcrumb. If a future refactor of the
    // redactor's `code` regex re-widens to substring-match, this
    // fails — and the on-call runbook explicitly greps for
    // `oauthConsent` to route the alert.
    expect(oidc.message).toMatch(/oauthConsent/);
  });

  it('fails on a crafted Location that starts-with the redirect URI but is a different origin+path (prefix bypass regression)', async () => {
    // An attacker (or a betterauth regression) that echoes a Location whose
    // string starts with the probe redirect URI but does NOT actually match
    // the registered client callback origin+path must fail. A naive
    // `startsWith` guard accepts:
    //   https://canary.wxyc.org/authorize-echo-attacker.example.com/?code=X
    // as valid because the string prefix matches; strict URL parsing
    // (origin+pathname compare) rejects it. The mock echoes the state so
    // the state-mismatch guard doesn't shadow the URL check we're pinning.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        // Echo the state so this test isolates the URL check.
        const location = `https://canary.wxyc.org/authorize-echo-attacker.example.com/?code=abcd1234&state=${encodeURIComponent(state)}`;
        return new Response(null, {
          status: 302,
          headers: { Location: location },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    // Message should route the on-call to session/redirect investigation.
    expect(oidc.message).toMatch(/redirect|Location/i);
  });

  // R2-F4: RFC 3986 §6.2.2.3 treats `/authorize-echo` and `/authorize-echo/`
  // as equivalent. Without normalization, a single-slash drift between the
  // trusted-client registration (server side) and the CFN
  // `OidcProbeRedirectUri` param (canary side) would page on-call every
  // tick despite no actual regression. Pin both directions of drift so a
  // future revert of the `normalizePath` helper regresses these tests.
  it('accepts a Location with a trailing slash when the configured redirect URI has none (R2-F4 trailing-slash normalization)', async () => {
    // Configured redirect URI: no trailing slash. Location: trailing slash.
    // Historically this failed the pathname compare; the fix normalizes.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo/?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('pass');
  });

  it('accepts a Location without a trailing slash when the configured redirect URI has one (R2-F4 trailing-slash normalization, reverse direction)', async () => {
    // Configured redirect URI: trailing slash. Location: no trailing slash.
    // The check must normalize both sides — otherwise the same page-tick
    // storm results from drift in the opposite direction.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    // Configure the redirect URI with a trailing slash so we exercise the
    // "expected has slash, Location doesn't" direction. `runCanary` accepts
    // an `oidcProbeRedirectUri` override on the config.
    const outcomes = await runCanary({
      ...baseConfig,
      djEmail: 'canary@wxyc.org',
      djPassword: 'pw',
      oidcProbeRedirectUri: 'https://canary.wxyc.org/authorize-echo/',
    });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('pass');
  });

  // R3-3: the R2 normalizePath stripped a SINGLE trailing slash. Any
  // concatenation bug in better-auth or a proxy that produces `//` (base
  // ending in `/` concatenated with a `/`-leading path, or a trusted-client
  // registration with a doubled slash) would flap the alarm every tick.
  // A single-slash strip that runs once turns `/authorize-echo//` into
  // `/authorize-echo/` — which still doesn't equal `/authorize-echo` after
  // its single-slash strip. The fix strips ALL trailing slashes; this
  // test pins that behavior.
  it('accepts a Location with a doubled trailing slash when the configured redirect URI has none (R3-3 regression)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: {
            // Doubled trailing slash — the shape a `base + '/' + path`
            // concatenation bug with a `/`-terminated base would emit.
            Location: `https://canary.wxyc.org/authorize-echo//?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('pass');
  });

  // R3-3: preserve the root-path case. `//` and `/` must compare equal
  // (they're the same resource by RFC 3986), but `/foo` must NOT collapse
  // to empty and start matching `/bar` accidentally. Pin the root case.
  it('accepts a doubled-slash root Location when the configured redirect URI is a bare host (R3-3 regression, root)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: {
            // Root path with a stray double slash. `new URL()` collapses
            // this back to `/` on parse, so this test primarily pins the
            // normalizePath contract rather than the pathological shape;
            // the important guarantee is that the strip doesn't collapse
            // `/` to empty and cause a non-root Location to match.
            Location: `https://canary.wxyc.org//?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({
      ...baseConfig,
      djEmail: 'canary@wxyc.org',
      djPassword: 'pw',
      oidcProbeRedirectUri: 'https://canary.wxyc.org/',
    });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('pass');
  });

  it('sends `redirect: manual` on /oauth2/authorize so the check can read the 302 Location header', async () => {
    // The check MUST NOT follow the 302 — inspecting the Location header is
    // the whole point of the probe (code + state parity live there). Node's
    // default fetch follows redirects, which would swallow the Location and
    // deliver whatever the redirect target returns (typically an ECONNREFUSED
    // against the canary.wxyc.org placeholder callback). Pin the request-init.
    let capturedRedirect: RequestInit['redirect'] | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        capturedRedirect = init?.redirect;
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('pass');
    expect(capturedRedirect).toBe('manual');
  });

  it('accepts a 303 See Other as well as a 302 Found — OAuth 2.0 does not pin the redirect status', async () => {
    // OAuth 2.0 (RFC 6749 §4.1.2) allows the authorization server to redirect
    // via either 302 or 303. better-auth currently returns 302, but a future
    // rev could switch to 303 without breaking the protocol. The check must
    // not flap on that rev.
    // The static `setUpAuthorizeMock` helper doesn't echo state (returns a
    // static Location); build a bespoke fetch that does.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 303,
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('pass');
  });

  it('does NOT retry on a 500 from /oauth2/authorize (single tick → single call → single fail)', async () => {
    // The 429 precondition path retries once at the sign-in layer, but the
    // oidc-authorize check itself must not double-tap the auth server on a
    // 5xx: retrying disguises the outage in dashboards (two failures per tick
    // that only surface as one) and doubles the auth-server load in exactly
    // the moment it's already unhealthy. Pin the call count.
    let authorizeCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/oauth2/authorize')) {
        authorizeCalls += 1;
        return new Response(JSON.stringify({ message: 'internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/sign-in/email': { status: 200, body: { token: 'fake-session-token', user: { id: 'canary-user-id' } } },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(oidc.status).toBe('fail');
    expect(authorizeCalls).toBe(1);
  });

  it('propagates a real 429 sign-in preflight — the retry succeeds on second try, and the OIDC check passes downstream', async () => {
    // `signInDj` retries once on 429 (respecting Retry-After up to 5s ceiling).
    // If the second attempt succeeds, the DJ-authed check proceeds normally.
    // This is distinct from the 401 case above (which is a terminal auth
    // precondition failure) — a 429 is transient, and the check tier that
    // depends on sign-in must actually see the retry path work end-to-end.
    let signInCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlString.includes('/sign-in/email')) {
        signInCalls += 1;
        if (signInCalls === 1) {
          return new Response(JSON.stringify({ error: 'rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
          });
        }
        return new Response(JSON.stringify({ token: 'fake-session-token', user: { id: 'canary-user-id' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlString.includes('/oauth2/authorize')) {
        const url = new URL(urlString);
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      const stubs: Record<string, { status: number; body: unknown }> = {
        '/healthcheck': { status: 200, body: { ok: true } },
        '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
        '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
        'explore.example.test/health': {
          status: 200,
          body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
        },
        '/token': { status: 200, body: { token: 'fake-jwt' } },
        '/library/?artist_name=': { status: 200, body: stereolabSearchResults },
        '/flowsheet': { status: 200, body: [] },
        '/library/rotation': { status: 200, body: [] },
      };
      for (const [pattern, resp] of Object.entries(stubs)) {
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

    const outcomes = await runCanary({ ...baseConfig, djEmail: 'canary@wxyc.org', djPassword: 'pw' });
    const oidc = outcomes.find((o) => o.name === 'oidc-authorize')!;

    expect(signInCalls).toBe(2);
    expect(oidc.status).toBe('pass');
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
    // Defensive: the runner-liveness probe shares the SSM-mock dispatch
    // with this block's `ssmSendMock.toHaveBeenCalledTimes(1)` assertion.
    // A leaked CANARY_GHA_RUNNER_TOKEN_SSM_PARAM from CI shell or a prior
    // test would cause a 2nd SSM call and fail this assertion opaquely.
    delete process.env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CANARY_BACKEND_URL;
    delete process.env.CANARY_AUTH_URL;
    delete process.env.CANARY_SEMANTIC_INDEX_URL;
    delete process.env.CANARY_PUBLISH_METRICS;
    delete process.env.CANARY_GITHUB_TOKEN_SSM_PARAM;
    delete process.env.CANARY_GITHUB_ISSUES_REPO;
    delete process.env.CANARY_GHA_RUNNER_TOKEN_SSM_PARAM;
  });

  it('fetches the SSM PAT and invokes the reporter when both env vars are set', async () => {
    process.env.CANARY_GITHUB_TOKEN_SSM_PARAM = '/wxyc-canary/github-token';
    process.env.CANARY_GITHUB_ISSUES_REPO = 'WXYC/wxyc-canary';
    setUpFetchMock({
      '/healthcheck': { status: 200, body: { ok: true } },
      '/proxy/library/search': { status: 200, body: proxyLibrarySearchResponse },
      '/graph/artists/search': { status: 200, body: { results: [{ id: 1, canonical_name: 'stereolab' }] } },
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
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
      'explore.example.test/health': {
        status: 200,
        body: { status: 'healthy', artist_count: 136_702, graph_db_age_seconds: 3_600 },
      },
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
