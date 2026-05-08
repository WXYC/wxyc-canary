import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCanary } from '../src/handler.js';
import type { CanaryConfig } from '../src/types.js';

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

  it('passes the 2 truly-anonymous checks and skips the 4 auth checks when no credentials are configured', async () => {
    const outcomes = await runCanary(baseConfig);

    expect(outcomes).toHaveLength(6);
    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    expect(byName['backend-healthcheck'].status).toBe('pass');
    expect(byName['semantic-index-search'].status).toBe('pass');
    expect(byName['proxy-library-search'].status).toBe('skipped');
    expect(byName['dj-library-search'].status).toBe('skipped');
    expect(byName['dj-flowsheet-read'].status).toBe('skipped');
    expect(byName['dj-rotation'].status).toBe('skipped');
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
