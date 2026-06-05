// Local-invocation entry for `npm run local`. Kept separate from
// handler.ts so the CLI can import `runCanary` without firing this
// autorun. The Lambda runtime invokes `handler.handler` directly and
// has no reason to reach this file.
import { handler } from './handler.js';

handler()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
