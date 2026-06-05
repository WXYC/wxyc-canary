// Bundle entry. esbuild prepends a `#!/usr/bin/env node` shebang to
// dist/cli.js, so this file is the executable. All testable logic lives
// in `./cli.js`'s `runCli`; this entry is a thin IO wiring shell so the
// test suite can import `runCli` directly without firing process.exit.
import { runCli, sanitizeForLog } from './cli.js';

/**
 * Format a thrown value for the fatal-error stderr line. `err` is typed
 * `unknown` because library code may `throw 'string'` / `throw {code:'X'}`
 * / `throw undefined`. The early `err instanceof Error` branch keeps the
 * stack trace; the else branch coerces with care so we never print a bare
 * `undefined` or `[object Object]`. The caller passes the result through
 * `sanitizeForLog` before writing to stderr — attacker text leaked via a
 * thrown Error message would otherwise bypass the per-outcome sanitizer
 * and forge a fake summary line in the GHA workflow log.
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

/**
 * Wait for stdout/stderr to drain, then force exit with the given code.
 *
 * `process.exit(code)` discards pending I/O when stdout is a pipe (the
 * documented `| jq` happy path), truncating the JSON line the gate
 * workflow consumes. Setting `process.exitCode` and waiting for the
 * loop to drain naturally is the textbook fix — except Node's global
 * `fetch` (undici) keeps an HTTP connection pool alive after the last
 * request (default ~4s idle keepalive; up to 60s on servers with
 * aggressive Keep-Alive headers). Letting the loop drain there means
 * the CLI hangs that long after writing its JSON, which compounds
 * across BS+LML+dj-site gate legs.
 *
 * The compromise: wait for explicit stdout/stderr drain callbacks, then
 * call `process.exit(code)` — by the time both drain callbacks fire,
 * the pipe buffer has flushed, but the connection pool is still alive;
 * the explicit exit closes everything without waiting for the pool to
 * idle out.
 */
async function exitAfterDrain(code: number): Promise<never> {
  // Trigger empty writes whose callbacks fire after the previously
  // queued bytes have flushed to the underlying transport. If the
  // streams are already drained, the callback fires on the next tick.
  //
  // Race against a 500ms timeout — if a stream is in a wedged state
  // (e.g. EPIPE after `wxyc-canary check | head -1`, where the reader
  // hangs up mid-write), the drain callback can sit on the writable's
  // pending queue indefinitely. The timeout caps total exit latency
  // so a stuck pipe doesn't leave the CLI hanging in a GHA workflow.
  // 500ms is comfortably longer than any local pipe drain takes; if
  // we hit it the bytes are lost anyway, and exiting promptly is more
  // valuable than blocking forever.
  await Promise.race([
    Promise.all([
      new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
      new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
    ]),
    new Promise<void>((resolve) => setTimeout(resolve, 500).unref()),
  ]);
  process.exit(code);
}

runCli(process.argv.slice(2), process.env, {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
}).then(
  (code) => {
    void exitAfterDrain(code);
  },
  (err) => {
    // Sanitize before write — formatFatal may interpolate err.message
    // that originated from a server response body (`canaryFetch` errors
    // include `r.rawText.slice(0, 200)` in their messages). Without
    // sanitization the fatal-error path bypasses the log-injection
    // defense the per-outcome sanitizer was added for.
    process.stderr.write(`fatal: ${sanitizeForLog(formatFatal(err))}\n`);
    // Exit 2 (invocation/internal error), not 1 (any check failed). The
    // CLI's exit-code contract distinguishes "your service is broken" (1)
    // from "your CLI invocation / runtime is broken" (2); an uncaught
    // throw in runCli is the latter.
    void exitAfterDrain(2);
  }
);
