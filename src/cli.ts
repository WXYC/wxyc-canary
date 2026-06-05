import { parseArgs, type ParseArgsConfig } from 'node:util';
import { checksForSuite, VALID_SUITES } from './checks.js';
import { runCanary } from './handler.js';
import type { CanaryConfig, Suite } from './types.js';

/**
 * The wxyc-canary CLI shim consumed by the WXYC/wiki#80 staging-gate
 * workflows (wxyc-shared `bs-lml-gate.yml`, dj-site `staging-gate.yml`).
 * Wraps the Lambda's `runCanary` so a GitHub Actions runner can invoke
 * the same probes against staging URLs without dragging the
 * Lambda-specific side effects (CloudWatch publish, SSM PAT resolution
 * for GH-issue mirroring and runner-liveness, Secrets Manager for DJ
 * credentials and the LML bearer). Credentials come from env vars only;
 * URLs come from flags. Lambda-only checks (gha-runner-online,
 * enrichment-quality, etc.) are not in any suite and therefore
 * unreachable from this entry point — see `checksForSuite` in
 * `checks.ts`.
 *
 * Exit codes:
 *   - 0 — every check returned `pass` or `skipped`.
 *   - 1 — at least one check returned `fail`. Stdout JSON names which.
 *   - 2 — invocation error (unknown subcommand, missing required flag,
 *         unknown flag, unknown suite, --help with bad flags). Stderr
 *         carries the human-readable reason. Distinct from exit 1 so the
 *         calling workflow can tell "your invocation is wrong" from
 *         "your service is broken".
 */

export type CliStreams = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

const USAGE = `wxyc-canary check [options]

Invokes wxyc-canary checks against an arbitrary BS/LML URL set. Designed
for the WXYC staging-gate workflows; not a replacement for the prod
Lambda.

Required flags:
  --base-url=<url>            Backend-Service base URL (no trailing slash)
  --auth-url=<url>            better-auth base URL (BS '/auth' route)
  --lml-url=<url>             library-metadata-lookup base URL
  --suite=<name>              one of: ${VALID_SUITES.join(', ')}

Environment variables (credentials — flags would leak into shell history):
  CANARY_DJ_EMAIL             optional; DJ-auth checks skip without it
  CANARY_DJ_PASSWORD          optional; pairs with CANARY_DJ_EMAIL
  CANARY_LML_API_KEY          optional; lml-auth check skips without it
  CANARY_ORIGIN_URL           optional; sent as Origin header on auth calls
                              (must match a BETTER_AUTH_TRUSTED_ORIGINS
                              value; defaults to https://dj.wxyc.org)
  CANARY_TIMEOUT_MS           optional; per-check fetch timeout

Exit codes:
  0  all checks passed or skipped
  1  at least one check failed
  2  invocation error (bad flags, unknown suite, etc.)

Output:
  stdout: one JSON line with {suite, outcomes, passed, failed, skipped}
  stderr: human-readable summary
`;

const parseConfig = {
  options: {
    'base-url': { type: 'string' },
    'auth-url': { type: 'string' },
    'lml-url': { type: 'string' },
    suite: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  // Reject unknown flags rather than silently ignoring them — operator
  // typos (--dj-email instead of CANARY_DJ_EMAIL) need to fail loudly so
  // the gate run doesn't quietly skip credential-dependent checks.
  strict: true,
  allowPositionals: true,
} as const satisfies ParseArgsConfig;

function isValidSuite(s: string): s is Suite {
  return (VALID_SUITES as readonly string[]).includes(s);
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliStreams): Promise<number> {
  // Early --help (works with or without a subcommand). parseArgs would
  // also accept `--help` mixed with the other flags, but matching here
  // means an operator running `wxyc-canary --help` (no subcommand) gets
  // usage rather than the "unknown subcommand" error.
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(USAGE);
    return 0;
  }

  let parsed;
  try {
    parsed = parseArgs({ ...parseConfig, args: argv });
  } catch (err) {
    // parseArgs throws ERR_PARSE_ARGS_UNKNOWN_OPTION etc. for unknown
    // flags. Forward the message so the operator sees which flag.
    io.stderr(`${(err as Error).message}\n`);
    io.stderr(USAGE);
    return 2;
  }

  const positionals = parsed.positionals;
  const subcommand = positionals[0];
  if (subcommand !== 'check') {
    io.stderr(
      subcommand === undefined
        ? 'missing subcommand (expected: check)\n'
        : `unknown subcommand '${subcommand}' (expected: check)\n`
    );
    io.stderr(USAGE);
    return 2;
  }

  const values = parsed.values;
  const missing: string[] = [];
  if (!values['base-url']) missing.push('--base-url');
  if (!values['auth-url']) missing.push('--auth-url');
  if (!values['lml-url']) missing.push('--lml-url');
  if (!values.suite) missing.push('--suite');
  if (missing.length > 0) {
    io.stderr(`missing required flag(s): ${missing.join(', ')}\n`);
    io.stderr(USAGE);
    return 2;
  }

  const suiteArg = values.suite as string;
  if (!isValidSuite(suiteArg)) {
    io.stderr(`unknown suite '${suiteArg}' (valid: ${VALID_SUITES.join(', ')})\n`);
    return 2;
  }

  // Build the CanaryConfig from flags + env. Credentials are env-only on
  // purpose — putting `--dj-password` on the command line would leak the
  // bearer into shell history, process listings, and CI run logs.
  const config: CanaryConfig = {
    backendUrl: values['base-url'] as string,
    authUrl: values['auth-url'] as string,
    semanticIndexUrl: '',
    lmlUrl: values['lml-url'] as string,
    djEmail: env.CANARY_DJ_EMAIL,
    djPassword: env.CANARY_DJ_PASSWORD,
    lmlApiKey: env.CANARY_LML_API_KEY,
    originUrl: env.CANARY_ORIGIN_URL,
    timeoutMs: env.CANARY_TIMEOUT_MS ? Number(env.CANARY_TIMEOUT_MS) : undefined,
    // Hard-off: the CLI must never publish CloudWatch metrics (it has no
    // AWS credentials and the staging probes don't belong on the prod
    // dashboards).
    publishMetrics: false,
    // Hard-off: writes are a Lambda-scheduled signal, not a gate signal
    // (45s poll budget makes them a poor blocker for PR merges).
    enableWriteProbe: false,
  };

  const outcomes = await runCanary(config, { checks: checksForSuite(suiteArg) });

  const passed = outcomes.filter((o) => o.status === 'pass').length;
  const failed = outcomes.filter((o) => o.status === 'fail').length;
  const skipped = outcomes.filter((o) => o.status === 'skipped').length;

  io.stdout(
    JSON.stringify({
      suite: suiteArg,
      passed,
      failed,
      skipped,
      outcomes,
    }) + '\n'
  );

  // Stderr summary: always include the headline + every non-pass with
  // its message so a workflow log reader sees the failing surface
  // without piping stdout through jq.
  const summaryLines = [
    `suite=${suiteArg} passed=${passed} failed=${failed} skipped=${skipped}`,
    ...outcomes
      .filter((o) => o.status !== 'pass')
      .map((o) => `  ${o.status} ${o.name} (${o.latencyMs}ms)${o.message ? ` — ${o.message}` : ''}`),
  ];
  io.stderr(summaryLines.join('\n') + '\n');

  return failed > 0 ? 1 : 0;
}

// Note: the bundle entry point is `src/cli-entry.ts`, which calls
// `runCli` and wires it to `process` IO. This file stays import-safe —
// vitest imports `runCli` here without side effects.
