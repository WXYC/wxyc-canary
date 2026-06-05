// Local-invocation entry for `npm run local`. Kept separate from
// handler.ts so the CLI can import `runCanary` without firing this
// autorun. The Lambda runtime invokes `handler.handler` directly and
// has no reason to reach this file.
import { handler } from './handler.js';

// Drain stdout/stderr before forcing exit — the Lambda `handler()`
// writes its JSON via `console.log` which is async to a pipe; without
// the drain step `npm run local | jq` could see truncated output. Same
// pattern as `cli-entry.ts`.
async function exitAfterDrain(code: number): Promise<never> {
  // Cap drain wait at 500ms so a wedged pipe (EPIPE from a reader that
  // hung up mid-write) doesn't leave the process hanging. See
  // cli-entry.ts for the full rationale.
  await Promise.race([
    Promise.all([
      new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
      new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
    ]),
    new Promise<void>((resolve) => setTimeout(resolve, 500).unref()),
  ]);
  process.exit(code);
}

handler().then(
  () => exitAfterDrain(0),
  (err) => {
    console.error(err);
    return exitAfterDrain(1);
  }
);
