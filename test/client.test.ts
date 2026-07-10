import { afterEach, describe, expect, it, vi } from 'vitest';
import { canaryFetch } from '../src/client.js';

/**
 * Pin the wxyc-canary#64 typed accessors on `FetchResult`. Two invariants:
 *
 *  - `location` lowercases the `Location` header at parse time so a call-site
 *    that reads `r.location` (typed accessor) never accidentally hits
 *    `undefined` by typing the header name in title-case. Every 3xx-inspection
 *    path in the codebase (the `oidc-authorize` check today, future consumers
 *    tomorrow) reads through this field.
 *  - `retryAfterMs` centralizes the seconds-form parse + negative-check that
 *    `signInDj` needs on 429. Missing / non-finite / negative all collapse to
 *    `undefined`; a valid non-negative seconds value returns milliseconds
 *    rounded to integer.
 *
 * The 429-negative case is the one that would silently regress if a call-site
 * re-parsed the header inline and forgot the sign check: `setTimeout(-500)`
 * is coerced to 0 by Node, but a negative value from a misbehaving server
 * should be treated as "no signal" and let the caller's fallback fire.
 */
describe('canaryFetch — FetchResult.location typed accessor (wxyc-canary#64)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the Location header regardless of the case the server emits', async () => {
    // Title-case on the wire is the historical failure mode — a naive
    // `headers?.Location` reader silently hits undefined and the check
    // fails with "no Location header" instead of the actual regression.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://example.test/redirect-target' },
          })
      )
    );
    const result = await canaryFetch('https://example.test/');
    expect(result.location).toBe('https://example.test/redirect-target');
  });

  it('returns undefined when no Location header is present (non-3xx / malformed 3xx)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    const result = await canaryFetch('https://example.test/');
    expect(result.location).toBeUndefined();
  });
});

describe('canaryFetch — FetchResult.retryAfterMs typed accessor (wxyc-canary#64)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a non-negative seconds-form Retry-After to integer milliseconds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'rate limited' }), {
            status: 429,
            headers: { 'Retry-After': '3' },
          })
      )
    );
    const result = await canaryFetch('https://example.test/');
    expect(result.retryAfterMs).toBe(3000);
  });

  it('rounds fractional seconds to the nearest millisecond', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': '1.5' },
          })
      )
    );
    const result = await canaryFetch('https://example.test/');
    expect(result.retryAfterMs).toBe(1500);
  });

  it('returns undefined when Retry-After is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 429 }))
    );
    const result = await canaryFetch('https://example.test/');
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('returns undefined on a negative Retry-After — treated as no signal, not a hostile 0ms delay', async () => {
    // A misbehaving server that emits `Retry-After: -5` shouldn't cause the
    // caller's `setTimeout(-5000)` to fire immediately; `undefined` lets the
    // caller's own fallback (a fixed 2s default in signInDj) take over.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': '-5' },
          })
      )
    );
    const result = await canaryFetch('https://example.test/');
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('returns undefined on a non-numeric Retry-After (date form / garbage)', async () => {
    // The date form (`Retry-After: Fri, 31 Dec 1999 23:59:59 GMT`) is
    // deliberately not parsed. `Number(...)` yields NaN → undefined.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': 'Fri, 31 Dec 1999 23:59:59 GMT' },
          })
      )
    );
    const result = await canaryFetch('https://example.test/');
    expect(result.retryAfterMs).toBeUndefined();
  });
});
