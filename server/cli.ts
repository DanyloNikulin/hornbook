#!/usr/bin/env node
// The `hornbook` command: start the server on this machine and open the UI.
//
//   hornbook                    journal in ~/Hornbook (seeded from the demo on first run),
//                               server on 127.0.0.1:8787, browser tab opened
//   hornbook --app              same, in a chromeless window (Chrome/Edge/Chromium)
//   hornbook --journal ./j      another folder
//   hornbook serve              just the server (Docker, services)
//   hornbook --host 0.0.0.0 --password …   hosted
//   hornbook doctor             what is installed for the zero-cost path
//
// Env: HORNBOOK_JOURNAL, HORNBOOK_PORT, HORNBOOK_HOST, HORNBOOK_PASSWORD.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMain } from '../scripts/lib/is-main.ts';
import { parseArgs, startServer } from './main.ts';
import { countLessons, openUrl, seedJournal } from './launch.ts';
import { DEMO_JOURNAL } from '../scripts/lib/demo-journal.ts';
import { pipelineEnv } from './secrets.ts';
import { defaultToolsDeps, machineInfo, toolStatuses } from './tools.ts';
import { DEFAULT_MANAGED_OLLAMA_PORT, recommend, toolsDir } from '../scripts/lib/tools.ts';
import { packageRoot } from '../scripts/lib/runtime.ts';

const repoRoot = packageRoot(import.meta.url);

export function defaultJournalDir(): string {
  return join(homedir(), 'Hornbook');
}

export async function cli(argv: readonly string[]): Promise<void> {
  if (argv[0] === 'doctor') {
    await doctor(resolve(parseArgs(argv).journal ?? defaultJournalDir()));
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`hornbook [serve] [--journal <dir>] [--port 8787] [--host 127.0.0.1] [--password …] [--app] [--no-open]

  --journal   folder that holds your lessons (default ~/Hornbook, seeded from the demo on first run)
  --app       open a chromeless window (needs Chrome, Edge, Chromium or Brave) instead of a tab
  serve       start the server without opening a window or tab
  --no-open   start the server only
  --host      listen address; anything but 127.0.0.1 is hosted mode — set --password
  --password  Basic-auth password for hosted mode (or HORNBOOK_PASSWORD)
  --origin    public origin behind a TLS proxy (or HORNBOOK_ORIGIN)
  HORNBOOK_JOB_TIMEOUT_MINUTES  background job limit; default 1440 for lessons, 60 for other jobs
  doctor      print what is installed for the zero-cost path (ffmpeg, whisper.cpp, Ollama)`);
    return;
  }

  const serve = argv[0] === 'serve';
  const effectiveArgv = serve ? argv.slice(1) : argv;
  const opts = parseArgs(effectiveArgv);
  const journal = resolve(opts.journal ?? defaultJournalDir());
  const compiledScripts = join(repoRoot, 'dist', 'node', 'scripts');

  if (seedJournal(DEMO_JOURNAL, journal)) {
    console.log(`Created your journal at ${journal} with ${countLessons(journal)} demo lesson(s). Delete the demo pairs whenever you like.`);
  }

  if (!existsSync(join(opts.dist, 'index.html'))) {
    console.error(`No UI build at ${opts.dist}. Run "npm run build" first.`);
    process.exitCode = 1;
    return;
  }

  const server = startServer({
    ...opts,
    journal,
    ...(existsSync(join(compiledScripts, 'process.js')) ? { scriptDir: compiledScripts } : {}),
  });
  const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}/`;

  if (!serve && !effectiveArgv.includes('--no-open')) {
    server.once('listening', () => {
      const cmd = openUrl(url, { app: effectiveArgv.includes('--app'), journalDir: journal });
      console.log(cmd.app ? `Opened Hornbook in an app window.` : `Opened ${url} in your browser.`);
      if (effectiveArgv.includes('--app') && !cmd.app) {
        console.log('No Chromium-family browser found for --app; opened a normal tab instead.');
      }
    });
  }


}

/** The setup page as a table, for a terminal. No network beyond the local Ollama. */
export async function doctor(journal: string): Promise<void> {
  const deps = defaultToolsDeps();
  const env = pipelineEnv(journal);
  const managedHost = `http://127.0.0.1:${process.env['HORNBOOK_OLLAMA_PORT'] ?? DEFAULT_MANAGED_OLLAMA_PORT}`;
  const [tools, machine] = await Promise.all([
    toolStatuses(deps, { env, managedOllama: { host: managedHost, running: false } }),
    machineInfo(deps),
  ]);
  console.log(`Hornbook doctor · tools folder ${toolsDir()}`);
  for (const t of tools) {
    const state = t.installed ? 'installed' : 'missing';
    const where = [t.source === 'none' ? '' : t.source, t.version ?? '', t.path ?? ''].filter(Boolean).join(' · ');
    console.log(`  ${t.id.padEnd(14)} ${state.padEnd(10)} ${where || t.detail}`);
  }
  const rec = recommend(machine);
  const gpu = machine.gpu ? `${machine.gpu.name} ${Math.round(machine.gpu.vramMb / 1024)} GB` : 'no NVIDIA GPU';
  console.log(`Machine: ${Math.round(machine.ramMb / 1024)} GB RAM · ${gpu}`);
  console.log(`Recommended: ${rec.ollamaModel} for writing, whisper ${rec.whisperModel} (${rec.whisperVariant} build) for hearing.`);
}

if (isMain(import.meta.url)) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    console.error('✘', (err as Error).message);
    process.exit(1);
  });
}
