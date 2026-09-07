#!/usr/bin/env node
// Update one coding CLI with its own updater, as a job of the server or from
// the terminal: `claude update`, `codex update`, `grok update`, `kimi upgrade`.
// The updater's output is the job log; afterwards the CLI is asked for its
// version again and the result is reported.
//
//   tsx scripts/update-cli.ts --cli codex

import { spawnProcess } from './lib/process.ts';
import { emitJobEvent } from './lib/job-protocol.ts';
import { isMain } from './lib/is-main.ts';
import { resolveCli } from './lib/cli-path.ts';
import { CLI_BIN_ENV, CODING_CLIS, missingCliMessage, type CodingCliKind } from './providers/cli-extract.ts';
import { CODING_CLI_META, isCodingCli, parseCliVersion } from './lib/coding-clis.ts';

export interface UpdateCliDeps {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** Run the CLI; `inherit` streams its output to ours, `capture` returns it. */
  run?: (bin: string, args: string[], mode: 'inherit' | 'capture') => Promise<{ code: number; out: string }>;
}

export interface UpdateCliResult {
  tool: CodingCliKind;
  path: string;
  version?: string;
}

export async function updateCli(kind: CodingCliKind, deps: UpdateCliDeps): Promise<UpdateCliResult> {
  const meta = CODING_CLI_META[kind];
  const configured = deps.env[CLI_BIN_ENV[kind]]?.trim() || kind;
  const bin = resolveCli(configured, deps.env, { exists: deps.exists, platform: deps.platform });
  if (!bin) throw new Error(missingCliMessage(kind, configured));
  const run = deps.run ?? runProcess;

  console.log(`$ ${bin} ${meta.update.join(' ')}`);
  const update = await run(bin, [...meta.update], 'inherit');
  if (update.code !== 0) throw new Error(`${meta.name} updater exited ${update.code}`);

  const probe = await run(bin, ['--version'], 'capture');
  const version = probe.code === 0 ? parseCliVersion(probe.out) : undefined;
  console.log(version ? `✓ ${meta.name} is now ${version}` : `✓ ${meta.name} updater finished`);
  return { tool: kind, path: bin, version };
}

function runProcess(bin: string, args: string[], mode: 'inherit' | 'capture'): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawnProcess(bin, args, { stdio: ['ignore', mode === 'capture' ? 'pipe' : 'inherit', 'inherit'] });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function cli(): Promise<void> {
  const kind = arg('--cli');
  if (!isCodingCli(kind)) {
    console.error(`Usage: tsx scripts/update-cli.ts --cli <${CODING_CLIS.join('|')}>`);
    process.exit(1);
  }
  const result = await updateCli(kind, { env: process.env });
  emitJobEvent({ type: 'result', result });
}

if (isMain(import.meta.url)) {
  cli().catch((err: unknown) => {
    console.error('\n✘', (err as Error).message);
    process.exit(1);
  });
}
