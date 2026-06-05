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
    // Asserting the substring 'passed' alone is a wrong-thing test — the
    // headline format `passed=N failed=N skipped=N` always contains
    // 'passed' regardless of which counter is which. Pin the exact
    // count + label so a future bug that swaps passed/failed gets caught.
    expect(stderr.join('')).toContain('passed=3 failed=0 skipped=2');
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

  // Note: the real "does not instantiate any AWS SDK client" assertion
  // lives in `test/cli-aws-isolation.test.ts`, which un-mocks
  // `runCanary` and feeds polluted env vars to verify the CLI's
  // env-sanitization layer actually short-circuits the AWS SDK
  // resolvers in handler.ts. The constructor spies below catch only the
  // already-trivial case where `runCanary` is mocked away.
  it('does not instantiate any AWS SDK client (cli.ts layer; full check in cli-aws-isolation.test.ts)', async () => {
    const { io } = setUpStreams();
    await runCli(baseArgv, {}, io);
    expect(cloudWatchCtorSpy).not.toHaveBeenCalled();
    expect(ssmCtorSpy).not.toHaveBeenCalled();
    expect(secretsManagerCtorSpy).not.toHaveBeenCalled();
  });

  it('projects outcomes to the documented contract — strips undocumented metrics field', async () => {
    runCanaryMock.mockResolvedValueOnce([
      // CheckOutcome supports a `metrics` field that the Lambda emits;
      // the CLI's documented stdout contract does NOT include it.
      {
        name: 'enrichment-quality',
        status: 'pass',
        latencyMs: 12,
        metrics: { EnrichmentLagSeconds: 5.4 },
      },
    ]);
    const { io, stdout } = setUpStreams();
    await runCli(baseArgv, {}, io);
    const parsed = JSON.parse(stdout.join('').trim());
    expect(parsed.outcomes[0]).toEqual({ name: 'enrichment-quality', status: 'pass', latencyMs: 12 });
    expect(parsed.outcomes[0]).not.toHaveProperty('metrics');
  });

  it('sanitizes control characters in outcome.message before stderr write (log-injection defense)', async () => {
    runCanaryMock.mockResolvedValueOnce([
      // Attacker-controlled response body that leaked into a check
      // error message could otherwise inject newlines and forge a
      // misleading "passed=5 failed=0" trailer in the workflow log.
      {
        name: 'lml-auth',
        status: 'fail',
        latencyMs: 78,
        message: 'rejected\nsuite=smoke passed=5 failed=0 skipped=0\nfake',
      },
    ]);
    const { io, stderr } = setUpStreams();
    await runCli(baseArgv, {}, io);
    const joined = stderr.join('');
    // The newlines in the injected message must be neutralized — no
    // line in the summary should begin with the forged headline.
    const lines = joined.split('\n');
    // The headline line is the real one; subsequent lines should be the
    // per-failure entries with the injected newline replaced by space.
    expect(lines[0]).toBe('suite=smoke passed=0 failed=1 skipped=0');
    expect(lines.some((l) => /^suite=smoke passed=5/.test(l))).toBe(false);
  });

  it('passes a sanitized env to runCanary so the SecretsManager fallback can never fire', async () => {
    const pollutedEnv: NodeJS.ProcessEnv = {
      CANARY_DJ_EMAIL: 'canary@wxyc.org',
      CANARY_DJ_PASSWORD: 'sekret',
      CANARY_LML_API_KEY: 'lml-bearer',
      // The values below MUST be stripped before runCanary sees them.
      CANARY_DJ_SECRET_ARN: 'arn:aws:secretsmanager:should-be-stripped',
      CANARY_LML_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:should-be-stripped',
      CANARY_GHA_RUNNER_TOKEN_SSM_PARAM: '/wxyc-canary/should-be-stripped',
    };
    const { io } = setUpStreams();
    await runCli(baseArgv, pollutedEnv, io);
    const [, opts] = runCanaryMock.mock.calls[0];
    expect(opts?.env).toEqual({
      CANARY_DJ_EMAIL: 'canary@wxyc.org',
      CANARY_DJ_PASSWORD: 'sekret',
      CANARY_LML_API_KEY: 'lml-bearer',
      CANARY_ORIGIN_URL: undefined,
    });
    // The polluted vars are NOT in opts.env.
    expect(opts?.env).not.toHaveProperty('CANARY_DJ_SECRET_ARN');
    expect(opts?.env).not.toHaveProperty('CANARY_LML_API_KEY_SECRET_ARN');
    expect(opts?.env).not.toHaveProperty('CANARY_GHA_RUNNER_TOKEN_SSM_PARAM');
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
  it('exits 2 on unknown --suite with a message listing valid suites + USAGE', async () => {
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
    // Every other exit-2 path prints USAGE for operator orientation —
    // the unknown-suite path should too.
    expect(msg).toContain('wxyc-canary check');
  });

  it('exits 2 on extra positional arguments after the subcommand', async () => {
    // parseArgs `strict: true` rejects unknown flags but not stray
    // positionals — `wxyc-canary check smoek --suite=smoke` (operator
    // typoed the suite as a positional) would otherwise silently ignore
    // 'smoek' and run the suite passed via the flag.
    const argv = [...baseArgv, 'leftover-positional'];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('')).toContain('leftover-positional');
  });

  it('exits 2 when CANARY_DJ_EMAIL is set without CANARY_DJ_PASSWORD', async () => {
    // The XOR case silently degraded to "skipped" before this check
    // existed: the gate would run green, with operators never learning
    // their DJ-auth checks had been quietly skipped.
    const { io, stderr } = setUpStreams();
    const code = await runCli(baseArgv, { CANARY_DJ_EMAIL: 'canary@wxyc.org' }, io);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('CANARY_DJ_EMAIL and CANARY_DJ_PASSWORD must be set together');
    expect(runCanaryMock).not.toHaveBeenCalled();
  });

  it('exits 2 when CANARY_DJ_PASSWORD is set without CANARY_DJ_EMAIL', async () => {
    const { io, stderr } = setUpStreams();
    expect(await runCli(baseArgv, { CANARY_DJ_PASSWORD: 'sekret' }, io)).toBe(2);
    expect(stderr.join('')).toContain('must be set together');
  });

  it('accepts both DJ vars set together', async () => {
    const { io } = setUpStreams();
    const code = await runCli(baseArgv, { CANARY_DJ_EMAIL: 'canary@wxyc.org', CANARY_DJ_PASSWORD: 'sekret' }, io);
    expect(code).toBe(0);
    expect(runCanaryMock).toHaveBeenCalledTimes(1);
  });

  it('accepts both DJ vars UNSET (no XOR, degrades to skipped — regression guard)', async () => {
    // Critical regression case: the XOR check must NOT catch
    // "both unset" — that case has to flow through to runCanary and
    // become SKIPPED outcomes for the DJ-auth checks. A misshape that
    // catches both-unset would block every CLI invocation that omits
    // DJ creds (the dj-site staging-gate use case, where the gate
    // tests against BS prod without DJ login).
    const { io } = setUpStreams();
    const code = await runCli(baseArgv, {}, io);
    expect(code).toBe(0);
    expect(runCanaryMock).toHaveBeenCalledTimes(1);
  });

  it('treats whitespace-only DJ creds as unset (CI-substitution footgun)', async () => {
    // Operator's GHA secret expands to empty string, gets quoted as ' '
    // by shell — the value is truthy as a JS string but logically unset.
    // Without `.trim()`, the XOR gate passes and signInDj fires with
    // garbage credentials.
    const { io, stderr } = setUpStreams();
    const code = await runCli(baseArgv, { CANARY_DJ_EMAIL: ' ', CANARY_DJ_PASSWORD: 'real-password' }, io);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('must be set together');
  });

  it('rejects whitespace-only flag values (--base-url=" ")', async () => {
    // Same shape: shell variable substitution or yaml-folded value
    // expanding to whitespace. Without `.trim()`, the truthy-string
    // check passes and the whitespace propagates into backendUrl,
    // surfacing later as a cryptic "Invalid URL" error from
    // canaryFetch instead of the clean exit-2 missing-flag contract.
    const argv = [
      'check',
      '--base-url= ',
      '--auth-url=https://x.test/auth',
      '--lml-url=https://x.test',
      '--suite=smoke',
    ];
    const { io, stderr } = setUpStreams();
    const code = await runCli(argv, {}, io);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--base-url');
    expect(stderr.join('')).toContain('missing required flag');
  });

  it('sanitizeForLog neutralizes U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR', async () => {
    // ASCII \\n is the obvious vector but JS/JSON-aware log parsers also
    // treat U+2028 / U+2029 as line breaks. The sanitizer must catch
    // them or the same injection forgery returns via Unicode.
    //
    // Assert directly on the absence of the offending code points in
    // stderr — NOT on `split('\\n')`, which doesn't split on
    // U+2028/U+2029 and would pass even if the regex didn't cover them.
    const injected = `rejected\u2028suite=smoke passed=5 failed=0 skipped=0\u2029fake`;
    runCanaryMock.mockResolvedValueOnce([{ name: 'lml-auth', status: 'fail', latencyMs: 78, message: injected }]);
    const { io, stderr } = setUpStreams();
    await runCli(baseArgv, {}, io);
    const joined = stderr.join('');
    // Direct assertion: the offending code points must not survive the
    // sanitizer. A regression that drops \\u2028/\\u2029 from the regex
    // would fail here regardless of how stderr is split.
    expect(joined).not.toContain('\u2028');
    expect(joined).not.toContain('\u2029');
    // Original text still appears (replaced with spaces, not deleted) —
    // regression guard that sanitization didn't swallow the message.
    expect(joined).toContain('rejected');
    expect(joined).toContain('fake');
  });

  it('--help mixed with unknown flag exits 2 (parseArgs runs before --help short-circuit)', async () => {
    // The bug this guards against: a previous implementation matched
    // `argv.includes('--help')` BEFORE parseArgs, so any combination of
    // bad flags + --help exited 0 silently. An automated tooling pass
    // that uses --help to validate a flag set would think the typo
    // was valid.
    const argv = ['check', '--help', '--bogus-flag'];
    const { io, stderr } = setUpStreams();
    expect(await runCli(argv, {}, io)).toBe(2);
    expect(stderr.join('')).toMatch(/--bogus-flag|unknown/i);
    expect(runCanaryMock).not.toHaveBeenCalled();
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
