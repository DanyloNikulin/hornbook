#!/usr/bin/env node
// Fetch one local tool into the tools folder, as a job of the server or from
// the terminal. Resolves the pinned release, prints the plan (source, size,
// checksum), streams the download with progress lines, verifies the SHA-256,
// unpacks, and records the install in manifest.json. A model for Ollama is
// pulled through Ollama's own API instead.
//
//   tsx scripts/setup-tool.ts --tool whisper [--variant cpu|cuda]
//   tsx scripts/setup-tool.ts --tool whisper-model --model small
//   tsx scripts/setup-tool.ts --tool ollama-model --model qwen2.5:7b
//   --expect-sha256 <hex>   override the published checksum (tests)
//   --tools <dir>           override the tools folder (HORNBOOK_TOOLS)
//
// Progress: lines `HORNBOOK_PROGRESS {"pct":42,"bytes":…,"total":…,"stage":"downloading"}`.
// Result:   `HORNBOOK_RESULT {"tool":"whisper","path":"…","version":"b4938"}`.

import { createHash } from 'node:crypto';
import { createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnProcess as spawn } from './lib/process.ts';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadPlan } from '../src/lib/api-types.ts';
import {
  TOOL_IDS,
  executableName,
  formatBytes,
  managedPaths,
  resolveDownload,
  toolsDir,
  type ToolId,
  type WhisperVariant,
} from './lib/tools.ts';
import { ollamaHost } from './providers/ollama.ts';
import { isMain } from './lib/is-main.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let lastPct = -1;
function progress(pct: number, extra: Record<string, unknown> = {}): void {
  const rounded = Math.max(0, Math.min(100, Math.floor(pct)));
  if (rounded === lastPct && !extra['stage']) return;
  lastPct = rounded;
  console.log(`HORNBOOK_PROGRESS ${JSON.stringify({ pct: rounded, ...extra })}`);
}

export interface SetupArgs {
  tool: ToolId;
  model?: string;
  variant?: WhisperVariant;
  expectSha256?: string;
  toolsDir: string;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
}

export async function setupTool(a: SetupArgs): Promise<{ tool: ToolId; path: string; version: string }> {
  const p = managedPaths(a.toolsDir, a.platform);
  mkdirSync(p.downloads, { recursive: true });
  const host = ollamaHost(a.env);
  const plan = await resolveDownload(a.tool, {
    platform: a.platform,
    arch: a.arch,
    variant: a.variant,
    model: a.model,
    fetch: a.fetch,
    ollamaHost: host,
  });
  const expected = a.expectSha256 ?? plan.sha256;
  console.log(`Source: ${plan.source}`);
  console.log(`File:   ${plan.fileName} (${formatBytes(plan.sizeBytes)})`);
  console.log(`URL:    ${plan.url}`);
  console.log(`SHA-256: ${expected ?? '(none published)'}`);

  if (plan.kind === 'pull') {
    await pullOllamaModel(host, plan, a.fetch);
    const result = { tool: a.tool, path: `${host} · ${plan.model}`, version: plan.version };
    recordInstall(p.manifest, { ...result, url: plan.url, sha256: null });
    return result;
  }

  if (!expected) throw new Error('No checksum is published for this file; refusing to install it unverified.');
  const archive = join(p.downloads, plan.fileName);
  await download(plan, archive, expected, a.fetch);

  let installed: string;
  if (plan.kind === 'file') {
    mkdirSync(p.whisperModels, { recursive: true });
    installed = p.whisperModel(plan.model ?? 'small');
    rmSync(installed, { force: true });
    renameSync(archive, installed);
  } else {
    installed = await unpack(a.tool as 'ffmpeg' | 'whisper' | 'ollama', archive, a.toolsDir, a.platform);
    rmSync(archive, { force: true });
  }
  progress(100, { stage: 'done' });
  const result = { tool: a.tool, path: installed, version: plan.version };
  recordInstall(p.manifest, { ...result, url: plan.url, sha256: expected });
  return result;
}

async function download(plan: DownloadPlan, target: string, expected: string, fetchImpl: typeof fetch): Promise<void> {
  const part = `${target}.part`;
  rmSync(part, { force: true });
  const res = await fetchImpl(plan.url, { headers: { 'User-Agent': 'hornbook-setup' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} from ${plan.url}`);
  const total = Number(res.headers.get('content-length')) || plan.sizeBytes;
  const hash = createHash('sha256');
  let bytes = 0;
  let lastTick = 0;
  progress(0, { bytes: 0, total, stage: 'downloading' });
  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (now - lastTick > 500) {
        lastTick = now;
        progress(total ? (bytes / total) * 100 : 0, { bytes, total });
      }
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(part));
  progress(99, { bytes, total, stage: 'verifying' });
  const actual = hash.digest('hex');
  if (actual !== expected.toLowerCase()) {
    rmSync(part, { force: true });
    throw new Error(`Checksum mismatch for ${plan.fileName}: expected ${expected}, got ${actual}. The file was deleted.`);
  }
  console.log(`Verified SHA-256 ${actual} (${formatBytes(bytes)}).`);
  rmSync(target, { force: true });
  renameSync(part, target);
}

/** Unpack into <tools>/<tool>: the executable's folder for ffmpeg and whisper, the whole tree for Ollama. */
async function unpack(tool: 'ffmpeg' | 'whisper' | 'ollama', archive: string, dir: string, platform: NodeJS.Platform): Promise<string> {
  const p = managedPaths(dir, platform);
  const target = tool === 'ffmpeg' ? p.ffmpegDir : tool === 'whisper' ? p.whisperDir : p.ollamaDir;
  const tmp = `${target}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  progress(99, { stage: 'extracting' });
  await extract(archive, tmp, platform);
  const wanted = executableName(tool, platform);
  const found = findFile(tmp, wanted);
  if (!found) throw new Error(`${wanted} was not inside ${basename(archive)}.`);
  rmSync(target, { recursive: true, force: true });
  if (tool === 'ollama') {
    // Keep the archive's own layout (bin/ and lib/ on Linux) under ollamaDir.
    const root = platform === 'linux' ? dirname(dirname(found)) : dirname(found);
    cpSync(root, target, { recursive: true });
  } else {
    cpSync(dirname(found), target, { recursive: true });
  }
  rmSync(tmp, { recursive: true, force: true });
  const installed = tool === 'ffmpeg' ? p.ffmpeg : tool === 'whisper' ? p.whisper : p.ollama;
  if (!existsSync(installed)) throw new Error(`Expected ${installed} after unpacking.`);
  return installed;
}

function extract(archive: string, into: string, platform: NodeJS.Platform): Promise<void> {
  const zip = archive.toLowerCase().endsWith('.zip');
  // Windows and macOS ship bsdtar, which reads zip; GNU tar on Linux does not.
  const cmd = platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : zip && platform === 'linux' ? 'unzip' : 'tar';
  const args = cmd === 'unzip' ? ['-q', '-o', archive, '-d', into] : archive.endsWith('.zst') ? ['--zstd', '-xf', archive, '-C', into] : ['-xf', archive, '-C', into];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`${cmd} could not run: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`))));
  });
}

function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath ?? (entry as { path?: string }).path ?? root, entry.name);
  }
  return undefined;
}

async function pullOllamaModel(host: string, plan: DownloadPlan, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: plan.model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama at ${host} answered HTTP ${res.status} to the pull.`);
  progress(0, { stage: 'pulling', total: plan.sizeBytes });
  let buffer = '';
  let done = false;
  for await (const chunk of Readable.fromWeb(res.body as never)) {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let row: { status?: string; completed?: number; total?: number; error?: string };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.error) throw new Error(`Ollama: ${row.error}`);
      if (typeof row.completed === 'number' && typeof row.total === 'number' && row.total > 0) {
        progress((row.completed / row.total) * 100, { bytes: row.completed, total: row.total, stage: row.status });
      } else if (row.status) {
        console.log(row.status);
      }
      if (row.status === 'success') done = true;
    }
  }
  if (!done) throw new Error('Ollama ended the pull without reporting success.');
  progress(100, { stage: 'done' });
}

function recordInstall(manifest: string, entry: Record<string, unknown>): void {
  let rows: Record<string, unknown>[] = [];
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      rows = [];
    }
  }
  rows = rows.filter((r) => r['tool'] !== entry['tool'] || (entry['tool'] === 'whisper-model' || entry['tool'] === 'ollama-model' ? r['path'] !== entry['path'] : false));
  rows.push({ ...entry, installedAt: new Date().toISOString() });
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify(rows, null, 2) + '\n', 'utf8');
}

export function sizeOf(path: string): number {
  return statSync(path).size;
}

async function cli(): Promise<void> {
  const tool = arg('--tool');
  if (!tool || !(TOOL_IDS as readonly string[]).includes(tool)) {
    console.error(`Usage: tsx scripts/setup-tool.ts --tool <${TOOL_IDS.join('|')}> [--model name] [--variant cpu|cuda]`);
    process.exit(1);
  }
  const variant = arg('--variant');
  const result = await setupTool({
    tool: tool as ToolId,
    model: arg('--model'),
    variant: variant === 'cuda' ? 'cuda' : variant === 'cpu' ? 'cpu' : undefined,
    expectSha256: arg('--expect-sha256'),
    toolsDir: arg('--tools') ?? toolsDir(),
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    fetch,
  });
  console.log(`✓ ${result.tool} → ${result.path}`);
  console.log(`HORNBOOK_RESULT ${JSON.stringify(result)}`);
}

if (isMain(import.meta.url)) {
  cli().catch((err: unknown) => {
    console.error('\n✘', (err as Error).message);
    process.exit(1);
  });
}
