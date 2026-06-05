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
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
    new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
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
