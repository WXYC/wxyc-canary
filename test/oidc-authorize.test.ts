import { afterEach, describe, expect, it, vi } from 'vitest';
import { oidcAuthorize } from '../src/oidc-authorize.js';
import type { CheckContext, OidcProbe } from '../src/types.js';

/**
 * Pin the wxyc-canary#63 multi-probe fan-out shape. `ctx.oidcProbes` is a
 * non-empty tuple; the check iterates every probe and — critically —
 * doesn't short-circuit on the first failure so multi-client damage
 * surfaces in one alarm rather than N. The single-probe path is already
 * covered exhaustively in `test/handler.test.ts` under the `runCanary —
 * oidc-authorize check` describe block; this file adds the N > 1 shape.
 *
 * These tests call `oidcAuthorize.run(ctx)` directly (bypassing `runCanary`)
 * because the env-loader always folds to a single-probe array today —
 * exercising the loop shape requires stitching a two-probe context in
 * TypeScript, which is straightforward at the check-function surface but
 * would require env-var plumbing changes that aren't shipping in this PR.
 */

function baseCtx(overrides: Partial<CheckContext>): CheckContext {
  return {
    backendUrl: 'https://api.example.test',
    authUrl: 'https://auth.example.test',
    semanticIndexUrl: 'https://explore.example.test',
    lmlUrl: 'https://lml.example.test',
    lmlApiKey: undefined,
    djAuth: {
      kind: 'signed-in',
      jwt: 'fake-jwt',
      sessionToken: 'fake-session-token',
      userId: 'canary-user-id',
    },
    oidcProbes: [
      {
        clientId: 'wxyc-canary',
        redirectUri: 'https://canary.wxyc.org/authorize-echo',
        label: 'wxyc-canary',
      },
    ],
    enrichmentPollTimeoutMs: 45_000,
    enrichmentPollIntervalMs: 2_000,
    ghaRunnerApiBase: 'https://api.github.com',
    ghaRunnerOrg: 'WXYC',
    ghaRunnerId: undefined,
    ghaRunnerToken: undefined,
    ...overrides,
  };
}

describe('oidc-authorize — multi-probe fan-out (wxyc-canary#63)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs every probe on a single tick — one probe failing does not short-circuit the others', async () => {
    // Two probes, one healthy and one broken. If the check short-circuited
    // on the first failure, the second probe would never run — hiding half
    // the damage on a multi-client outage. Assert both are hit by counting
    // authorize calls per client_id.
    const callsByClientId: Record<string, number> = {};
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!urlString.includes('/oauth2/authorize')) {
        return new Response(`unmatched ${urlString}`, { status: 599 });
      }
      const url = new URL(urlString);
      const clientId = url.searchParams.get('client_id') ?? 'unknown';
      callsByClientId[clientId] = (callsByClientId[clientId] ?? 0) + 1;
      const state = url.searchParams.get('state') ?? '';
      if (clientId === 'wxyc-canary') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      // The wikijs probe: server returns 500 (BS#1571-shape damage on this
      // one client only). Multi-client fan-out should still catch it AND
      // still run the wxyc-canary probe.
      return new Response(JSON.stringify({ message: 'BetterAuthError: model oauthConsent missing' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const probes: readonly [OidcProbe, ...OidcProbe[]] = [
      {
        clientId: 'wxyc-canary',
        redirectUri: 'https://canary.wxyc.org/authorize-echo',
        label: 'wxyc-canary',
      },
      {
        clientId: 'wikijs',
        redirectUri: 'https://wiki.wxyc.org/oauth/callback',
        label: 'wikijs',
      },
    ];
    const ctx = baseCtx({ oidcProbes: probes });

    // The check throws on failure; we assert the shape of the error.
    await expect(oidcAuthorize.run(ctx)).rejects.toThrow();

    // Both probes ran — the healthy one wasn't skipped by an early return.
    expect(callsByClientId['wxyc-canary']).toBe(1);
    expect(callsByClientId['wikijs']).toBe(1);
  });

  it('prefixes the failing probe label on the aggregated error so on-call routes to the right owner', async () => {
    // One probe fails, one passes. The message must carry the failing
    // probe's label so the runbook can route ("wikijs registration
    // missing") without the on-call reading Location headers.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!urlString.includes('/oauth2/authorize')) {
        return new Response(`unmatched ${urlString}`, { status: 599 });
      }
      const url = new URL(urlString);
      const clientId = url.searchParams.get('client_id') ?? 'unknown';
      const state = url.searchParams.get('state') ?? '';
      if (clientId === 'wxyc-canary') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://canary.wxyc.org/authorize-echo?code=abcd1234&state=${encodeURIComponent(state)}`,
          },
        });
      }
      return new Response(JSON.stringify({ message: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const probes: readonly [OidcProbe, ...OidcProbe[]] = [
      {
        clientId: 'wxyc-canary',
        redirectUri: 'https://canary.wxyc.org/authorize-echo',
        label: 'wxyc-canary',
      },
      {
        clientId: 'wikijs',
        redirectUri: 'https://wiki.wxyc.org/oauth/callback',
        label: 'wikijs',
      },
    ];

    let caught: Error | undefined;
    try {
      await oidcAuthorize.run(baseCtx({ oidcProbes: probes }));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // The failing probe's label is prefixed; the passing probe's label is
    // NOT (only failures are aggregated).
    expect(caught!.message).toMatch(/\[wikijs\]/);
    expect(caught!.message).not.toMatch(/\[wxyc-canary\]/);
  });

  it('passes when every probe passes (multi-probe happy path)', async () => {
    // Both probes 302 to their respective registered callbacks. The check
    // must pass (no throw), matching the single-probe pass semantics.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!urlString.includes('/oauth2/authorize')) {
        return new Response(`unmatched ${urlString}`, { status: 599 });
      }
      const url = new URL(urlString);
      const clientId = url.searchParams.get('client_id') ?? 'unknown';
      const state = url.searchParams.get('state') ?? '';
      const redirectMap: Record<string, string> = {
        'wxyc-canary': 'https://canary.wxyc.org/authorize-echo',
        wikijs: 'https://wiki.wxyc.org/oauth/callback',
      };
      const base = redirectMap[clientId] ?? 'https://canary.wxyc.org/authorize-echo';
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${base}?code=abcd1234&state=${encodeURIComponent(state)}`,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const probes: readonly [OidcProbe, ...OidcProbe[]] = [
      {
        clientId: 'wxyc-canary',
        redirectUri: 'https://canary.wxyc.org/authorize-echo',
        label: 'wxyc-canary',
      },
      {
        clientId: 'wikijs',
        redirectUri: 'https://wiki.wxyc.org/oauth/callback',
        label: 'wikijs',
      },
    ];

    await expect(oidcAuthorize.run(baseCtx({ oidcProbes: probes }))).resolves.toBeUndefined();
  });
});
