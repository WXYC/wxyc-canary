import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportOutcomesToGitHub } from '../src/github-issues.js';
import type { CheckOutcome } from '../src/types.js';

type GitHubCall = { method: string; path: string; body?: unknown };

function setUpGitHubMock(responses: Array<{ match: (call: GitHubCall) => boolean; status: number; body: unknown }>) {
  const calls: GitHubCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace('https://api.github.com', '');
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const call: GitHubCall = { method, path, body };
    calls.push(call);
    for (const r of responses) {
      if (r.match(call)) {
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(`unmatched ${method} ${path}`, { status: 599 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

const failedOutcome: CheckOutcome = {
  name: 'dj-library-search',
  status: 'fail',
  latencyMs: 1234,
  message: 'expected 2xx, got 503: catalog search is disabled.',
};

const passedOutcome: CheckOutcome = {
  name: 'dj-library-search',
  status: 'pass',
  latencyMs: 200,
};

describe('reportOutcomesToGitHub', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes the open issue with a recovery comment when a previously-failing check passes', async () => {
    const { calls } = setUpGitHubMock([
      {
        match: (c) => c.method === 'GET' && c.path.startsWith('/search/issues'),
        status: 200,
        body: { items: [{ number: 42 }] },
      },
      {
        match: (c) => c.method === 'POST' && c.path === '/repos/WXYC/wxyc-canary/issues/42/comments',
        status: 201,
        body: { id: 7 },
      },
      {
        match: (c) => c.method === 'PATCH' && c.path === '/repos/WXYC/wxyc-canary/issues/42',
        status: 200,
        body: { number: 42, state: 'closed' },
      },
    ]);

    await reportOutcomesToGitHub([passedOutcome], {
      token: 'fake-pat',
      repo: 'WXYC/wxyc-canary',
    });

    const comment = calls.find((c) => c.method === 'POST' && c.path === '/repos/WXYC/wxyc-canary/issues/42/comments');
    expect(comment).toBeDefined();
    expect((comment!.body as { body: string }).body).toMatch(/recovered/i);

    const close = calls.find((c) => c.method === 'PATCH' && c.path === '/repos/WXYC/wxyc-canary/issues/42');
    expect(close).toBeDefined();
    expect((close!.body as { state: string }).state).toBe('closed');
  });

  it('does nothing when a check passes and no open issue exists for it', async () => {
    const { calls } = setUpGitHubMock([
      { match: (c) => c.method === 'GET' && c.path.startsWith('/search/issues'), status: 200, body: { items: [] } },
    ]);

    await reportOutcomesToGitHub([passedOutcome], { token: 'fake-pat', repo: 'WXYC/wxyc-canary' });

    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toEqual([]);
  });

  it('ignores skipped outcomes — no search, no write, no churn on operator-gap state', async () => {
    const skippedOutcome: CheckOutcome = {
      name: 'dj-library-search',
      status: 'skipped',
      latencyMs: 0,
      message: 'no DJ credentials configured',
    };
    const { calls } = setUpGitHubMock([]);

    await reportOutcomesToGitHub([skippedOutcome], { token: 'fake-pat', repo: 'WXYC/wxyc-canary' });

    expect(calls).toEqual([]);
  });

  it('comments on the existing open issue instead of opening a duplicate when a check fails again', async () => {
    const { calls } = setUpGitHubMock([
      {
        match: (c) => c.method === 'GET' && c.path.startsWith('/search/issues'),
        status: 200,
        body: { items: [{ number: 42 }] },
      },
      {
        match: (c) => c.method === 'POST' && c.path === '/repos/WXYC/wxyc-canary/issues/42/comments',
        status: 201,
        body: { id: 1 },
      },
    ]);

    await reportOutcomesToGitHub([failedOutcome], {
      token: 'fake-pat',
      repo: 'WXYC/wxyc-canary',
    });

    const create = calls.find((c) => c.method === 'POST' && c.path === '/repos/WXYC/wxyc-canary/issues');
    expect(create).toBeUndefined();
    const comment = calls.find((c) => c.method === 'POST' && c.path === '/repos/WXYC/wxyc-canary/issues/42/comments');
    expect(comment).toBeDefined();
    const body = comment!.body as { body: string };
    expect(body.body).toMatch(/503/);
  });

  it('opens a new issue when a check fails and no open issue exists for it', async () => {
    const { calls } = setUpGitHubMock([
      // search: no existing issue
      { match: (c) => c.method === 'GET' && c.path.startsWith('/search/issues'), status: 200, body: { items: [] } },
      // create issue
      {
        match: (c) => c.method === 'POST' && c.path === '/repos/WXYC/wxyc-canary/issues',
        status: 201,
        body: { number: 42, html_url: 'https://github.com/WXYC/wxyc-canary/issues/42' },
      },
    ]);

    await reportOutcomesToGitHub([failedOutcome], {
      token: 'fake-pat',
      repo: 'WXYC/wxyc-canary',
    });

    const create = calls.find((c) => c.method === 'POST' && c.path === '/repos/WXYC/wxyc-canary/issues');
    expect(create).toBeDefined();
    const body = create!.body as { title: string; labels: string[]; body: string };
    expect(body.title).toMatch(/dj-library-search/);
    expect(body.labels).toContain('canary');
    expect(body.labels).toContain('canary:check:dj-library-search');
    expect(body.body).toMatch(/503/);
  });
});
