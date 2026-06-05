import { parseArgs, type ParseArgsConfig } from 'node:util';
import { checksForSuite, VALID_SUITES } from './checks.js';
import { runCanary } from './handler.js';
import type { CanaryConfig, CheckOutcome, Suite } from './types.js';

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
  CANARY_DJ_EMAIL             DJ login email. Pairs with CANARY_DJ_PASSWORD;
                              both must be set together or both unset
                              (XOR is rejected as an invocation error).
                              When both unset, DJ-auth checks skip.
  CANARY_DJ_PASSWORD          DJ login password. See above.
  CANARY_LML_API_KEY          optional; lml-auth check skips without it
  CANARY_ORIGIN_URL           optional; sent as Origin header on auth calls
                              (must match a BETTER_AUTH_TRUSTED_ORIGINS
                              value; defaults to https://dj.wxyc.org)

Exit codes:
  0  all checks passed or skipped
  1  at least one check failed
  2  invocation error (bad flags, unknown suite, etc.)

Output:
  stdout: one JSON line with {suite, outcomes, passed, failed, skipped}
          where each outcome is {name, status, latencyMs, message?}
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

/**
 * Strip control characters from text that originated outside the CLI
 * (HTTP response bodies surfaced inside CheckOutcome.message). Without
 * this, a probed endpoint serving attacker-controlled text could inject
 * newlines into the stderr summary and forge a misleading "passed=5
 * failed=0" trailer in the GHA workflow log.
 */
function sanitizeForLog(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * Project the CheckOutcome shape to the documented CLI contract
 * (name, status, latencyMs, optional message). Strips fields like
 * `metrics` that the Lambda may attach to outcomes — the CLI's stdout
 * contract is narrower than the Lambda's internal data shape, and a
 * future check that returns custom metrics must not silently leak them
 * into the gate workflow's parsed JSON.
 */
function projectOutcomeForStdout(o: CheckOutcome): {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  latencyMs: number;
  message?: string;
} {
  return o.message === undefined
    ? { name: o.name, status: o.status, latencyMs: o.latencyMs }
    : { name: o.name, status: o.status, latencyMs: o.latencyMs, message: o.message };
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliStreams): Promise<number> {
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

  // --help is honored only AFTER parseArgs accepts the rest of the
  // flag set. Doing it earlier (e.g. `argv.includes('--help')`) would
  // mask unknown-flag / typo errors that the strict parser was meant to
  // catch — an operator running `wxyc-canary check --help --typo-flag`
  // would get exit 0 and never learn about the typo.
  if (parsed.values.help) {
    io.stdout(USAGE);
    return 0;
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
  // Reject extra positionals — `wxyc-canary check smoke` (positional
  // suite name) and `wxyc-canary check --suite=smoke leftover` both fall
  // here. parseArgs's `strict: true` governs flags only; positionals are
  // always permissive with `allowPositionals: true`.
  if (positionals.length > 1) {
    io.stderr(`unexpected positional argument(s): ${positionals.slice(1).join(', ')}\n`);
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
    io.stderr(USAGE);
    return 2;
  }

  // DJ creds must be set together. XOR (only one set) was previously
  // silently degraded to "no DJ credentials configured" because
  // resolveDjCredentials in handler.ts requires both. Surfacing it as
  // an invocation error keeps the gate operator from shipping a workflow
  // where DJ-auth checks are accidentally skipped.
  const djEmailSet = !!env.CANARY_DJ_EMAIL;
  const djPasswordSet = !!env.CANARY_DJ_PASSWORD;
  if (djEmailSet !== djPasswordSet) {
    io.stderr(
      `CANARY_DJ_EMAIL and CANARY_DJ_PASSWORD must be set together (found: EMAIL=${djEmailSet ? 'set' : 'unset'}, PASSWORD=${djPasswordSet ? 'set' : 'unset'})\n`
    );
    return 2;
  }

  // Build the CanaryConfig from flags + env. Credentials are env-only on
  // purpose — putting `--dj-password` on the command line would leak the
  // bearer into shell history, process listings, and CI run logs.
  const config: CanaryConfig = {
    backendUrl: values['base-url'] as string,
    authUrl: values['auth-url'] as string,
    // semanticIndexUrl is required on CanaryConfig but unused by every
    // smoke check. The empty string is a tripwire: if a future suite
    // ever includes `semantic-index-search` without surfacing this
    // field as a flag, the check will fail with a clear URL-construction
    // error rather than silently hitting the wrong host.
    semanticIndexUrl: '',
    lmlUrl: values['lml-url'] as string,
    djEmail: env.CANARY_DJ_EMAIL,
    djPassword: env.CANARY_DJ_PASSWORD,
    lmlApiKey: env.CANARY_LML_API_KEY,
    originUrl: env.CANARY_ORIGIN_URL,
    // Defensive: `runCanary` doesn't currently read publishMetrics (the
    // flag governs only the Lambda `handler()` wrapper), but a future
    // refactor that moves the publish step into runCanary should
    // honor this guard. Setting it here documents the CLI's intent.
    publishMetrics: false,
    // Defensive: same shape — enableWriteProbe gates the
    // `enrichment-quality` check, which isn't in any suite, so this
    // flag is unreachable by the CLI today. Set explicitly to harden
    // against a future suite addition.
    enableWriteProbe: false,
  };

  // Pass a sanitized env to runCanary so its resolver helpers
  // (`resolveDjCredentials`, `resolveLmlApiKey`, `resolveGhaRunnerToken`)
  // can't reach for AWS-SDK secret backends via env vars the CLI doesn't
  // advertise. Without this, an operator with CANARY_DJ_SECRET_ARN
  // exported in their shell would silently trigger SecretsManagerClient
  // instantiation despite the README's "no AWS SDK" contract.
  const sanitizedEnv: NodeJS.ProcessEnv = {
    CANARY_DJ_EMAIL: env.CANARY_DJ_EMAIL,
    CANARY_DJ_PASSWORD: env.CANARY_DJ_PASSWORD,
    CANARY_LML_API_KEY: env.CANARY_LML_API_KEY,
    CANARY_ORIGIN_URL: env.CANARY_ORIGIN_URL,
  };

  const outcomes = await runCanary(config, {
    checks: checksForSuite(suiteArg),
    env: sanitizedEnv,
  });

  const passed = outcomes.filter((o) => o.status === 'pass').length;
  const failed = outcomes.filter((o) => o.status === 'fail').length;
  const skipped = outcomes.filter((o) => o.status === 'skipped').length;

  io.stdout(
    JSON.stringify({
      suite: suiteArg,
      passed,
      failed,
      skipped,
      outcomes: outcomes.map(projectOutcomeForStdout),
    }) + '\n'
  );

  // Stderr summary: always include the headline + every non-pass with
  // its message so a workflow log reader sees the failing surface
  // without piping stdout through jq. Sanitize the message — it
  // originates from check error throws that interpolate `r.rawText`
  // slices (server response bodies); a probed endpoint serving
  // attacker-controlled text could otherwise inject newlines and forge
  // a misleading trailer in the GHA workflow log.
  const summaryLines = [
    `suite=${suiteArg} passed=${passed} failed=${failed} skipped=${skipped}`,
    ...outcomes
      .filter((o) => o.status !== 'pass')
      .map((o) => {
        const msg = o.message ? ` — ${sanitizeForLog(o.message)}` : '';
        return `  ${o.status} ${o.name} (${o.latencyMs}ms)${msg}`;
      }),
  ];
  io.stderr(summaryLines.join('\n') + '\n');

  return failed > 0 ? 1 : 0;
}

// Note: the bundle entry point is `src/cli-entry.ts`, which calls
// `runCli` and wires it to `process` IO. This file stays import-safe —
// vitest imports `runCli` here without side effects.
