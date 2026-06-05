// Bundle entry. esbuild prepends a `#!/usr/bin/env node` shebang to
// dist/cli.js, so this file is the executable. All testable logic lives
// in `./cli.js`'s `runCli`; this entry is a thin IO wiring shell so the
// test suite can import `runCli` directly without firing process.exit.
import { runCli } from './cli.js';

runCli(process.argv.slice(2), process.env, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  }
);
