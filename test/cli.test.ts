import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { runCanary as runCanaryType } from '../src/handler.js';

// Mock runCanary so the CLI tests can drive it deterministically. The
// suite-filter end-to-end test lives in `test/checks.test.ts`; here we
// verify the CLI's arg parsing, config assembly, exit-code logic, and
// stdout/stderr discipline.
const { runCanaryMock } = vi.hoisted(() => ({
  // `vi.fn<typeof runCanaryType>()` types `.mock.calls[0]` as the
  // tuple of runCanary's argument types — tests can then index into
  // `[config, opts]` without TS narrowing it to `never`.
  runCanaryMock: vi.fn() as ReturnType<typeof vi.fn<typeof runCanaryType>>,
}));
vi.mock('../src/handler.js', () => ({
  runCanary: runCanaryMock,
}));

// AWS SDK isolation: spy on every client constructor the codebase uses and
// assert in the relevant test that none are instantiated when the CLI
// runs. Catches regressions where a future refactor wires AWS-SDK
// resolution into the CLI path.
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

const baseArgv = [
  'check',
  '--base-url=https://bs-staging.example.test',
  '--auth-url=https://bs-staging.example.test/auth',
  '--lml-url=https://lml-staging.example.test',
  '--suite=smoke',
];

beforeEach(() => {
  runCanaryMock.mockReset();
  runCanaryMock.mockResolvedValue([
    { name: 'backend-healthcheck', status: 'pass', latencyMs: 12 },
    { name: 'proxy-library-search', status: 'pass', latencyMs: 45 },
    { name: 'dj-library-search', status: 'skipped', latencyMs: 0, message: 'no DJ credentials configured' },
    { name: 'dj-flowsheet-read', status: 'skipped', latencyMs: 0, message: 'no DJ credentials configured' },
    { name: 'lml-auth', status: 'pass', latencyMs: 78 },
  ]);
  cloudWatchCtorSpy.mockReset();
  ssmCtorSpy.mockReset();
  secretsManagerCtorSpy.mockReset();
});

describe('runCli — happy paths', () => {
  it('exits 0 when every check returns pass or skipped', async () => {
    const { io, stdout, stderr } = setUpStreams();
    const code = await runCli(baseArgv, {}, io);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr.join('')).toContain('passed');
  });

  it('emits one JSON line on stdout matching the contract shape', async () => {
    const { io, stdout } = setUpStreams();
    await runCli(baseArgv, {}, io);
    const joined = stdout.join('');
    // exactly one JSON object, no trailing data after the closing brace+newline
    const lines = joined.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({
      suite: 'smoke',
      passed: 3,
      failed: 0,
      skipped: 2,
      outcomes: [
        { name: 'backend-healthcheck', status: 'pass', latencyMs: 12 },
        { name: 'proxy-library-search', status: 'pass', latencyMs: 45 },
        { name: 'dj-library-search', status: 'skipped', latencyMs: 0, message: 'no DJ credentials configured' },
        { name: 'dj-flowsheet-read', status: 'skipped', latencyMs: 0, message: 'no DJ credentials configured' },
        { name: 'lml-auth', status: 'pass', latencyMs: 78 },
      ],
    });
  });

  it('threads CLI URLs into the CanaryConfig passed to runCanary', async () => {
    const { io } = setUpStreams();
    await runCli(baseArgv, {}, io);
    expect(runCanaryMock).toHaveBeenCalledTimes(1);
    const [config] = runCanaryMock.mock.calls[0];
    expect(config).toMatchObject({
      backendUrl: 'https://bs-staging.example.test',
      authUrl: 'https://bs-staging.example.test/auth',
      lmlUrl: 'https://lml-staging.example.test',
      publishMetrics: false,
    });
  });

  it('passes the smoke-filtered checks array to runCanary', async () => {
    const { io } = setUpStreams();
    await runCli(baseArgv, {}, io);
    const [, opts] = runCanaryMock.mock.calls[0];
    expect(opts?.checks?.map((c) => c.name)).toEqual([
      'backend-healthcheck',
      'proxy-library-search',
      'dj-library-search',
      'dj-flowsheet-read',
      'lml-auth',
    ]);
  });

  it('reads DJ credentials and LML bearer from env, not flags', async () => {
    const { io } = setUpStreams();
    await runCli(
      baseArgv,
      {
        CANARY_DJ_EMAIL: 'canary@wxyc.org',
        CANARY_DJ_PASSWORD: 'sekret',
        CANARY_LML_API_KEY: 'lml-bearer',
      },
      io
    );
    const [config] = runCanaryMock.mock.calls[0];
    expect(config).toMatchObject({
      djEmail: 'canary@wxyc.org',
      djPassword: 'sekret',
      lmlApiKey: 'lml-bearer',
    });
  });

  it('does not instantiate any AWS SDK client', async () => {
    const { io } = setUpStreams();
    await runCli(baseArgv, {}, io);
    expect(cloudWatchCtorSpy).not.toHaveBeenCalled();
    expect(ssmCtorSpy).not.toHaveBeenCalled();
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });
});

describe('runCli — failure mapping', () => {
  it('exits 1 when any check returns fail', async () => {
    runCanaryMock.mockResolvedValueOnce([
      { name: 'backend-healthcheck', status: 'pass', latencyMs: 12 },
      { name: 'lml-auth', status: 'fail', latencyMs: 78, message: 'LML rejected bearer with 401' },
    ]);
    const { io, stdout, stderr } = setUpStreams();
    const code = await runCli(baseArgv, {}, io);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.join('').trim());
    expect(parsed.failed).toBe(1);
    // Stderr summary must name the failing check so the runner log points
    // an on-call at the surface, not just a count.
    expect(stderr.join('')).toContain('lml-auth');
  });

  it('exits 1 even when only one of many checks fails', async () => {
    runCanaryMock.mockResolvedValueOnce([
      { name: 'backend-healthcheck', status: 'pass', latencyMs: 12 },
      { name: 'proxy-library-search', status: 'pass', latencyMs: 45 },
      { name: 'lml-auth', status: 'fail', latencyMs: 78, message: 'boom' },
      { name: 'dj-library-search', status: 'pass', latencyMs: 30 },
      { name: 'dj-flowsheet-read', status: 'pass', latencyMs: 22 },
    ]);
    const { io } = setUpStreams();
    expect(await runCli(baseArgv, {}, io)).toBe(1);
  });

  it('skipped-only outcomes are still exit 0', async () => {
    runCanaryMock.mockResolvedValueOnce([
      { name: 'backend-healthcheck', status: 'skipped', latencyMs: 0, message: 'skipped' },
    ]);
    const { io } = setUpStreams();
    expect(await runCli(baseArgv, {}, io)).toBe(0);
  });
});

describe('runCli — argument validation', () => {
  it('exits 2 on unknown --suite with a message listing valid suites', async () => {
    const argv = [
      'check',
      '--base-url=https://x.test',
      '--auth-url=https://x.test/auth',
      '--lml-url=https://x.test',
      '--suite=bogus',
    ];
    const { io, stderr } = setUpStreams();
    const code = await runCli(argv, {}, io);
    expect(code).toBe(2);
    const msg = stderr.join('');
    expect(msg).toContain('bogus');
    expect(msg).toContain('smoke');
  });

  it('exits 2 when --base-url is missing', async () => {
    const argv = ['check', '--auth-url=https://x.test/auth', '--lml-url=https://x.test', '--suite=smoke'];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('')).toContain('--base-url');
  });

  it('exits 2 when --auth-url is missing', async () => {
    const argv = ['check', '--base-url=https://x.test', '--lml-url=https://x.test', '--suite=smoke'];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('')).toContain('--auth-url');
  });

  it('exits 2 when --lml-url is missing', async () => {
    const argv = ['check', '--base-url=https://x.test', '--auth-url=https://x.test/auth', '--suite=smoke'];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('')).toContain('--lml-url');
  });

  it('exits 2 when --suite is missing', async () => {
    const argv = ['check', '--base-url=https://x.test', '--auth-url=https://x.test/auth', '--lml-url=https://x.test'];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('')).toContain('--suite');
  });

  it('exits 2 on unknown subcommand', async () => {
    const argv = ['banana', ...baseArgv.slice(1)];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('').toLowerCase()).toContain('banana');
  });

  it('exits 2 on unknown flag (e.g. --dj-email — credentials are env-only)', async () => {
    const argv = [...baseArgv, '--dj-email=oops@wxyc.org'];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('')).toMatch(/--dj-email|unknown/i);
  });

  it('--help exits 0, writes usage to stdout, nothing to stderr', async () => {
    const { io, stdout, stderr } = setUpStreams();
    expect(await runCli(['--help'], {}, io)).toBe(0);
    expect(stdout.join('')).toMatch(/wxyc-canary check/i);
    expect(stderr.join('')).toBe('');
    // help path must not invoke runCanary
    expect(runCanaryMock).not.toHaveBeenCalled();
  });
});
