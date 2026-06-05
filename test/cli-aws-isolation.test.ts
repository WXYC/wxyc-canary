import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real-runCanary AWS-SDK isolation test. The companion file `cli.test.ts`
// mocks `runCanary` and so cannot exercise the SDK-resolver code path —
// its AWS-SDK-constructor assertion was tautological. This file un-mocks
// `runCanary` (does not call `vi.mock('../src/handler.js')` at all) and
// pollutes `process.env` directly with the secret-store pointers that
// would normally cause `resolveDjCredentials` / `resolveLmlApiKey` /
// `resolveGhaRunnerToken` to instantiate SecretsManagerClient or
// SSMClient. The polluted env MUST go onto process.env (not just the
// runCli `env` parameter) — if it only went into the runCli parameter,
// then `runCanary`'s fallback `opts?.env ?? process.env` would pull from
// a clean process.env and the test would pass even if the CLI's
// sanitization layer were deleted.
//
// We mock fetch so the actual HTTP probes don't go out.

const { cloudWatchCtorSpy, ssmCtorSpy, secretsManagerCtorSpy } = vi.hoisted(() => ({
  cloudWatchCtorSpy: vi.fn(),
  ssmCtorSpy: vi.fn(),
  secretsManagerCtorSpy: vi.fn(),
}));
vi.mock('@aws-sdk/client-cloudwatch', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudwatch')>('@aws-sdk/client-cloudwatch');
  return {
    ...actual,
    CloudWatchClient: vi.fn().mockImplementation((...args: unknown[]) => {
      cloudWatchCtorSpy(...args);
      return { send: vi.fn(async () => ({})) };
    }),
  };
});
vi.mock('@aws-sdk/client-ssm', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ssm')>('@aws-sdk/client-ssm');
  return {
    ...actual,
    SSMClient: vi.fn().mockImplementation((...args: unknown[]) => {
      ssmCtorSpy(...args);
      return { send: vi.fn(async () => ({})) };
    }),
  };
});
vi.mock('@aws-sdk/client-secrets-manager', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-secrets-manager')>(
    '@aws-sdk/client-secrets-manager'
  );
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation((...args: unknown[]) => {
      secretsManagerCtorSpy(...args);
      return { send: vi.fn(async () => ({})) };
    }),
  };
});

import { runCli, type CliStreams } from '../src/cli.js';

function setUpStreams(): { io: CliStreams; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    },
  };
}

// Mock fetch so the CLI's probes don't hit real network. Every smoke
// check expects a 2xx with a sensible body — return them so checks pass
// (or skip naturally) and `runCli` reaches the no-AWS-SDK assertion.
function setUpFetchMock(): void {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlString.includes('/healthcheck')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (urlString.includes('/proxy/library/search') || urlString.includes('/library/?artist_name')) {
      return new Response(
        JSON.stringify(urlString.includes('/proxy/') ? { results: [], total: 0, query: 'x' } : [{ id: 1 }]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    if (urlString.includes('/flowsheet')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlString.includes('/api/v1/lookup')) {
      // First call: good bearer → 200. Second call: known-bad bearer → 401.
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlString.includes('/sign-in/email') || urlString.includes('/token')) {
      return new Response(JSON.stringify({ token: 'fake-jwt', user: { id: 'fake-id' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(`unmatched ${urlString}`, { status: 599 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const baseArgv = [
  'check',
  '--base-url=https://bs-staging.example.test',
  '--auth-url=https://bs-staging.example.test/auth',
  '--lml-url=https://lml-staging.example.test',
  '--suite=smoke',
];

// Snapshot + restore process.env around each test so the polluted vars
// don't leak between cases or to other test files. Vitest gives each
// test a shared process, so beforeEach/afterEach discipline is the
// difference between deterministic and order-dependent runs.
//
// Snapshot the full CANARY_* surface (not just the *_SECRET_ARN /
// *_SSM_PARAM keys we pollute) so any CI-set CANARY_DJ_EMAIL etc.
// doesn't leak through `runCli(baseArgv, process.env, io)`. Otherwise
// a real DJ login would attempt against the mock'd fetch and a future
// refactor that moved an AWS-SDK call behind the signin/lml-auth path
// would surface flakes only in CI.
const SNAPSHOTTED_VARS = [
  // Polluted directly by each test:
  'CANARY_DJ_SECRET_ARN',
  'CANARY_LML_API_KEY_SECRET_ARN',
  'CANARY_GHA_RUNNER_TOKEN_SSM_PARAM',
  'CANARY_GITHUB_TOKEN_SSM_PARAM',
  'CANARY_PUBLISH_METRICS',
  'CANARY_LOCAL',
  // Cleared so a CI-set value doesn't reach runCli:
  'CANARY_DJ_EMAIL',
  'CANARY_DJ_PASSWORD',
  'CANARY_LML_API_KEY',
  'CANARY_ORIGIN_URL',
] as const;

type PollutableVar =
  | 'CANARY_DJ_SECRET_ARN'
  | 'CANARY_LML_API_KEY_SECRET_ARN'
  | 'CANARY_GHA_RUNNER_TOKEN_SSM_PARAM'
  | 'CANARY_GITHUB_TOKEN_SSM_PARAM'
  | 'CANARY_PUBLISH_METRICS'
  | 'CANARY_LOCAL';

function pollute(values: Partial<Record<PollutableVar, string>>): void {
  for (const [k, v] of Object.entries(values)) {
    process.env[k] = v;
  }
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  cloudWatchCtorSpy.mockReset();
  ssmCtorSpy.mockReset();
  secretsManagerCtorSpy.mockReset();
  setUpFetchMock();
  // Snapshot + clear every CANARY_* var the CLI might react to, so
  // each test starts from a known-clean env regardless of what the CI
  // runner or other test files set.
  for (const k of SNAPSHOTTED_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SNAPSHOTTED_VARS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

describe('cli — AWS SDK isolation under polluted process.env (real runCanary)', () => {
  it('does not instantiate SecretsManagerClient when CANARY_DJ_SECRET_ARN is in process.env', async () => {
    pollute({ CANARY_DJ_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000:secret:dj/creds' });
    const { io } = setUpStreams();
    // Critical: we pass an empty `env` to runCli (matching the cli-entry
    // wiring where env=process.env on the prod path). The CLI's
    // sanitization layer must strip CANARY_DJ_SECRET_ARN before forwarding
    // to runCanary. If sanitization were removed, runCanary's
    // `opts?.env ?? process.env` would land on the polluted process.env
    // and the spy WOULD fire — that's what makes this test load-bearing.
    await runCli(baseArgv, process.env, io);
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });

  it('does not instantiate SecretsManagerClient when CANARY_LML_API_KEY_SECRET_ARN is in process.env', async () => {
    pollute({ CANARY_LML_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000:secret:lml/key' });
    const { io } = setUpStreams();
    await runCli(baseArgv, process.env, io);
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });

  it('does not instantiate SSMClient when CANARY_GHA_RUNNER_TOKEN_SSM_PARAM is in process.env', async () => {
    pollute({ CANARY_GHA_RUNNER_TOKEN_SSM_PARAM: '/wxyc-canary/should-be-stripped' });
    const { io } = setUpStreams();
    await runCli(baseArgv, process.env, io);
    expect(ssmCtorSpy).not.toHaveBeenCalled();
  });

  it('does not instantiate CloudWatchClient even with publishMetrics flag externally suggested', async () => {
    pollute({ CANARY_PUBLISH_METRICS: 'true' });
    const { io } = setUpStreams();
    await runCli(baseArgv, process.env, io);
    expect(cloudWatchCtorSpy).not.toHaveBeenCalled();
  });

  it('all three SDK constructors stay quiet with the full polluted-env combo', async () => {
    pollute({
      CANARY_DJ_SECRET_ARN: 'arn:should-not-fire',
      CANARY_LML_API_KEY_SECRET_ARN: 'arn:should-not-fire',
      CANARY_GHA_RUNNER_TOKEN_SSM_PARAM: '/should-not-fire',
      CANARY_GITHUB_TOKEN_SSM_PARAM: '/should-not-fire',
      CANARY_PUBLISH_METRICS: 'true',
      CANARY_LOCAL: 'true',
    });
    const { io } = setUpStreams();
    await runCli(baseArgv, process.env, io);
    expect(cloudWatchCtorSpy).not.toHaveBeenCalled();
    expect(ssmCtorSpy).not.toHaveBeenCalled();
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });

  it('does not mutate the operator-supplied env object (CLI builds a fresh sanitizedEnv)', async () => {
    pollute({ CANARY_DJ_SECRET_ARN: 'arn:should-not-fire' });
    const snapshot = { ...process.env };
    const { io } = setUpStreams();
    await runCli(baseArgv, process.env, io);
    // The CLI must not delete/overwrite keys on the operator's env;
    // a `delete env.X`-style sanitization would corrupt process.env
    // for the rest of the process lifetime.
    expect(process.env.CANARY_DJ_SECRET_ARN).toBe(snapshot.CANARY_DJ_SECRET_ARN);
  });
});
