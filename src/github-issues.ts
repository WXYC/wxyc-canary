import type { CheckOutcome } from './types.js';

export type ReporterConfig = {
  token: string;
  repo: string;
};

const GITHUB_API = 'https://api.github.com';

function checkLabel(name: string): string {
  return `canary:check:${name}`;
}

function issueTitle(o: CheckOutcome): string {
  const head = (o.message ?? '').split('\n')[0].slice(0, 80);
  return `[canary] ${o.name}: ${head}`;
}

function issueBody(o: CheckOutcome): string {
  return [
    `Canary check **${o.name}** is failing.`,
    '',
    `**Latest error**:`,
    '```',
    o.message ?? '(no message)',
    '```',
  ].join('\n');
}

async function githubFetch(path: string, init: RequestInit, token: string): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wxyc-canary',
      ...(init.headers ?? {}),
    },
  });
}

async function findOpenIssue(repo: string, checkName: string, token: string): Promise<{ number: number } | undefined> {
  const q = `repo:${repo} is:issue is:open label:${checkLabel(checkName)}`;
  const url = `/search/issues?q=${encodeURIComponent(q)}`;
  const res = await githubFetch(url, { method: 'GET' }, token);
  if (!res.ok) {
    throw new Error(`github search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { items?: Array<{ number: number }> };
  return body.items?.[0];
}

async function commentOnIssue(repo: string, issueNumber: number, outcome: CheckOutcome, token: string): Promise<void> {
  const body = [
    `Canary check **${outcome.name}** still failing.`,
    '',
    '```',
    outcome.message ?? '(no message)',
    '```',
  ].join('\n');
  const res = await githubFetch(
    `/repos/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
    token
  );
  if (!res.ok) {
    throw new Error(`github comment failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function openIssue(repo: string, outcome: CheckOutcome, token: string): Promise<void> {
  const res = await githubFetch(
    `/repos/${repo}/issues`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: issueTitle(outcome),
        body: issueBody(outcome),
        labels: ['canary', checkLabel(outcome.name)],
      }),
    },
    token
  );
  if (!res.ok) {
    throw new Error(`github create-issue failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function closeIssueWithRecoveryComment(
  repo: string,
  issueNumber: number,
  outcome: CheckOutcome,
  token: string
): Promise<void> {
  const recovery = `Canary check **${outcome.name}** recovered at ${new Date().toISOString()} (latency ${outcome.latencyMs}ms). Closing.`;
  const commentRes = await githubFetch(
    `/repos/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: recovery }),
    },
    token
  );
  if (!commentRes.ok) {
    throw new Error(
      `github recovery-comment failed (${commentRes.status}): ${(await commentRes.text()).slice(0, 200)}`
    );
  }
  const closeRes = await githubFetch(
    `/repos/${repo}/issues/${issueNumber}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    },
    token
  );
  if (!closeRes.ok) {
    throw new Error(`github close-issue failed (${closeRes.status}): ${(await closeRes.text()).slice(0, 200)}`);
  }
}

export async function reportOutcomesToGitHub(outcomes: CheckOutcome[], config: ReporterConfig): Promise<void> {
  for (const o of outcomes) {
    if (o.status === 'skipped') continue;
    const existing = await findOpenIssue(config.repo, o.name, config.token);
    if (o.status === 'fail') {
      if (existing) {
        await commentOnIssue(config.repo, existing.number, o, config.token);
      } else {
        await openIssue(config.repo, o, config.token);
      }
    } else if (o.status === 'pass' && existing) {
      await closeIssueWithRecoveryComment(config.repo, existing.number, o, config.token);
    }
  }
}
