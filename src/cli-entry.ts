// Bundle entry. esbuild prepends a `#!/usr/bin/env node` shebang to
// dist/cli.js, so this file is the executable. All testable logic lives
// in `./cli.js`'s `runCli`; this entry is a thin IO wiring shell so the
// test suite can import `runCli` directly without firing process.exit.
import { runCli } from './cli.js';

/**
 * Format a thrown value for the fatal-error stderr line. `err` is typed
 * `unknown` because library code may `throw 'string'` / `throw {code:'X'}`
 * / `throw undefined`. The early `err instanceof Error` branch keeps the
 * stack trace; the else branch coerces with care so we never print a bare
 * `undefined` or `[object Object]`.
 */
function formatFatal(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message ?? String(err);
  }
  if (err === undefined) return 'undefined (no Error object thrown)';
  if (err === null) return 'null (no Error object thrown)';
  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

runCli(process.argv.slice(2), process.env, {
  // Wrap stdout/stderr writes so the entry can await pipe drainage before
  // exiting. `process.stdout.write` is async when stdout is a pipe (the
  // documented `| jq` happy path); calling process.exit(code) immediately
  // after a sync-style write truncates the pipe buffer. Setting
  // process.exitCode and letting the loop drain naturally avoids the race.
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
}).then(
  (code) => {
    // Drain stdout/stderr before letting the process exit. Without an
    // explicit drain wait, `process.exit(code)` discards pending I/O when
    // stdout is a pipe — truncating the JSON line the gate workflow
    // consumes via `jq`. Setting exitCode and letting the event loop
    // drain naturally is the Node-documented fix.
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`fatal: ${formatFatal(err)}\n`);
    // Exit 2 (invocation/internal error), not 1 (any check failed). The
    // CLI's exit-code contract distinguishes "your service is broken" (1)
    // from "your CLI invocation / runtime is broken" (2); an uncaught
    // throw in runCli is the latter.
    process.exitCode = 2;
  }
);
