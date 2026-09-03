#!/usr/bin/env node
// The `hornbook` command: start the server on this machine and open the UI.
//
//   hornbook                    journal in ~/Hornbook (seeded from the demo on first run),
//                               server on 127.0.0.1:8787, browser tab opened
//   hornbook --app              same, in a chromeless window (Chrome/Edge/Chromium)
//   hornbook --journal ./j      another folder
//   hornbook --no-open          just the server (Docker, services)
//   hornbook --host 0.0.0.0 --password …   hosted
//
// Env: HORNBOOK_JOURNAL, HORNBOOK_PORT, HORNBOOK_HOST, HORNBOOK_PASSWORD.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../scripts/lib/is-main.ts';
import { parseArgs, startServer } from './main.ts';
import { countLessons, openUrl, seedJournal } from './launch.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export function defaultJournalDir(): string {
  return join(homedir(), 'Hornbook');
}

export async function cli(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`hornbook [--journal <dir>] [--port 8787] [--host 127.0.0.1] [--password …] [--app] [--no-open]

  --journal   folder that holds your lessons (default ~/Hornbook, seeded from the demo on first run)
  --app       open a chromeless window (needs Chrome, Edge, Chromium or Brave) instead of a tab
  --no-open   start the server only
  --host      listen address; anything but 127.0.0.1 is hosted mode — set --password
  --password  Basic-auth password for hosted mode (or HORNBOOK_PASSWORD)`);
    return;
  }

  const opts = parseArgs(argv);
  const journal = resolve(opts.journal ?? defaultJournalDir());

  if (seedJournal(join(repoRoot, 'journal'), journal)) {
    console.log(`Created your journal at ${journal} with ${countLessons(journal)} demo lesson(s). Delete the demo pairs whenever you like.`);
  }

  if (!existsSync(join(opts.dist, 'index.html'))) {
    console.error(`No UI build at ${opts.dist}. Run "npm run build" first.`);
    process.exitCode = 1;
    return;
  }

  const server = startServer({ ...opts, journal });
  const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}/`;

  if (!argv.includes('--no-open')) {
    server.once('listening', () => {
      const cmd = openUrl(url, { app: argv.includes('--app'), journalDir: journal });
      console.log(cmd.app ? `Opened Hornbook in an app window.` : `Opened ${url} in your browser.`);
      if (argv.includes('--app') && !cmd.app) {
        console.log('No Chromium-family browser found for --app; opened a normal tab instead.');
      }
    });
  }

  const stop = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (isMain(import.meta.url)) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    console.error('✘', (err as Error).message);
    process.exit(1);
  });
}
