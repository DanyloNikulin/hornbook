#!/usr/bin/env node
// Launcher for the `hornbook` command. The real CLI is TypeScript
// (server/cli.ts); this file only starts Node with the tsx loader that ships
// as a dependency, resolved next to this package rather than from the
// caller's working directory.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve('tsx')).href;
const cli = fileURLToPath(new URL('../server/cli.ts', import.meta.url));

const child = spawn(process.execPath, ['--import', loader, cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
