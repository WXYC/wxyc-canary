import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real-runCanary AWS-SDK isolation test. The companion file `cli.test.ts`
// mocks `runCanary` and so cannot exercise the SDK-resolver code path —
// its AWS-SDK-constructor assertion was tautological. This file un-mocks
// `runCanary` (does not call `vi.mock('../src/handler.js')` at all) and
// feeds the CLI an env polluted with the exact secret-store pointers
// that would normally cause `resolveDjCredentials` /
// `resolveLmlApiKey` / `resolveGhaRunnerToken` to instantiate
// SecretsManagerClient or SSMClient. If the CLI's env-sanitization
// layer works as designed, none of those constructors should fire.
//
// We mock fetch instead so the actual HTTP probes don't go out.

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

beforeEach(() => {
  cloudWatchCtorSpy.mockReset();
  ssmCtorSpy.mockReset();
  secretsManagerCtorSpy.mockReset();
  setUpFetchMock();
});

describe('cli — AWS SDK isolation under polluted env (real runCanary)', () => {
  it('does not instantiate SecretsManagerClient when CANARY_DJ_SECRET_ARN is set', async () => {
    const { io } = setUpStreams();
    await runCli(
      baseArgv,
      {
        // The exact env-var that previously routed through to SDK
        // instantiation via the fallback inside resolveDjCredentials.
        CANARY_DJ_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000:secret:dj/creds',
        // DJ creds intentionally unset so resolveDjCredentials would
        // otherwise reach for the SecretArn fallback.
      },
      io
    );
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });

  it('does not instantiate SecretsManagerClient when CANARY_LML_API_KEY_SECRET_ARN is set', async () => {
    const { io } = setUpStreams();
    await runCli(
      baseArgv,
      {
        CANARY_LML_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000:secret:lml/key',
      },
      io
    );
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });

  it('does not instantiate SSMClient when CANARY_GHA_RUNNER_TOKEN_SSM_PARAM is set', async () => {
    const { io } = setUpStreams();
    await runCli(
      baseArgv,
      {
        CANARY_GHA_RUNNER_TOKEN_SSM_PARAM: '/wxyc-canary/should-be-stripped',
      },
      io
    );
    expect(ssmCtorSpy).not.toHaveBeenCalled();
  });

  it('does not instantiate CloudWatchClient even with publishMetrics flag externally suggested', async () => {
    // publishMetrics is controlled by config (hard-off in cli.ts), not
    // env — but a future bug that wired the env-var to override it
    // would surface here.
    const { io } = setUpStreams();
    await runCli(baseArgv, { CANARY_PUBLISH_METRICS: 'true' }, io);
    expect(cloudWatchCtorSpy).not.toHaveBeenCalled();
  });

  it('all three SDK constructors stay quiet with the full polluted-env combo', async () => {
    const { io } = setUpStreams();
    await runCli(
      baseArgv,
      {
        CANARY_DJ_SECRET_ARN: 'arn:should-not-fire',
        CANARY_LML_API_KEY_SECRET_ARN: 'arn:should-not-fire',
        CANARY_GHA_RUNNER_TOKEN_SSM_PARAM: '/should-not-fire',
        CANARY_GITHUB_TOKEN_SSM_PARAM: '/should-not-fire',
        CANARY_PUBLISH_METRICS: 'true',
        CANARY_LOCAL: 'true',
      },
      io
    );
    expect(cloudWatchCtorSpy).not.toHaveBeenCalled();
    expect(ssmCtorSpy).not.toHaveBeenCalled();
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });
});
