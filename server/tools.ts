// What is installed on this machine for the zero-cost path, where it comes
// from (managed by Hornbook, on PATH, configured in Settings, or an Ollama
// running elsewhere), and the environment that lets the pipeline scripts find
// the managed copies without any change to them.

import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { totalmem } from 'node:os';
import type { MachineInfo, ToolStatus } from '../src/lib/api-types.ts';
import { managedPaths, preferredWhisperModel, toolsDir } from '../scripts/lib/tools.ts';
import { resolveCli } from '../scripts/lib/cli-path.ts';
import { ollamaHost } from '../scripts/providers/ollama.ts';
import { canComplete } from './probe.ts';

export interface ToolsDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  exists: (path: string) => boolean;
  listDir: (dir: string) => string[];
  fetch: typeof fetch;
  /** Run a command briefly and return its stdout, or undefined when it cannot run. */
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<string | undefined>;
  totalMemMb: number;
}

export function defaultToolsDeps(env: NodeJS.ProcessEnv = process.env): ToolsDeps {
  return {
    env,
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
    listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    fetch,
    run: runBriefly,
    totalMemMb: Math.round(totalmem() / 1048576),
  };
}

export function runBriefly(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? out : undefined));
  });
}

// ── Managed copies in the pipeline's environment ─────────────────────────────

export interface ToolsEnvOptions {
  dir: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  listDir?: (dir: string) => string[];
  managedOllamaHost?: string;
}

/**
 * Fill in what the managed tools provide, without overriding anything the
 * user configured: the managed ffmpeg goes first on PATH, the managed
 * whisper binary and preferred model become WHISPER_BIN / WHISPER_MODEL,
 * and a running managed Ollama becomes OLLAMA_HOST.
 */
export function toolsEnv(base: NodeJS.ProcessEnv, opts: ToolsEnvOptions): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const listDir = opts.listDir ?? ((dir: string) => (existsSync(dir) ? readdirSync(dir) : []));
  const p = managedPaths(opts.dir, platform);
  const out: NodeJS.ProcessEnv = { ...base };
  if (exists(p.ffmpeg)) {
    const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    out[key] = [p.ffmpegDir, out[key]].filter(Boolean).join(delimiter);
  }
  if (!out['WHISPER_BIN']?.trim() && exists(p.whisper)) out['WHISPER_BIN'] = p.whisper;
  if (!out['WHISPER_MODEL']?.trim()) {
    const preferred = preferredWhisperModel(managedWhisperModels(listDir(p.whisperModels)));
    if (preferred) out['WHISPER_MODEL'] = p.whisperModel(preferred);
  }
  if (!out['OLLAMA_HOST']?.trim() && opts.managedOllamaHost) out['OLLAMA_HOST'] = opts.managedOllamaHost;
  return out;
}

export function managedWhisperModels(files: readonly string[]): string[] {
  return files.flatMap((f) => {
    const m = f.match(/^ggml-(.+)\.bin$/);
    return m ? [m[1]] : [];
  });
}

// ── Status of each tool ──────────────────────────────────────────────────────

export interface StatusOptions {
  /** Environment with the journal's secrets applied (what the pipeline would see). */
  env: NodeJS.ProcessEnv;
  managedOllama: { host: string; running: boolean };
}

export async function toolStatuses(deps: ToolsDeps, opts: StatusOptions): Promise<ToolStatus[]> {
  const dir = toolsDir(deps.env, deps.platform);
  const p = managedPaths(dir, deps.platform);
  const [ffmpeg, whisper, whisperModel, ollama] = await Promise.all([
    ffmpegStatus(deps, p),
    whisperStatus(deps, p, opts.env),
    whisperModelStatus(deps, p, opts.env),
    ollamaStatus(deps, p, opts),
  ]);
  const ollamaModel = await ollamaModelStatus(deps, ollama);
  return [ffmpeg, whisper, whisperModel, ollama, ollamaModel];
}

async function ffmpegStatus(deps: ToolsDeps, p: ReturnType<typeof managedPaths>): Promise<ToolStatus> {
  if (deps.exists(p.ffmpeg)) {
    return { id: 'ffmpeg', installed: true, source: 'managed', path: p.ffmpeg, version: await ffmpegVersion(deps, p.ffmpeg), detail: 'Managed by Hornbook.' };
  }
  const onPath = resolveCli('ffmpeg', deps.env, { exists: deps.exists, platform: deps.platform });
  if (onPath) {
    return { id: 'ffmpeg', installed: true, source: 'system', path: onPath, version: await ffmpegVersion(deps, onPath), detail: 'Found on PATH.' };
  }
  return { id: 'ffmpeg', installed: false, source: 'none', detail: 'Needed to read recordings and slides.' };
}

async function ffmpegVersion(deps: ToolsDeps, bin: string): Promise<string | undefined> {
  const out = await deps.run(bin, ['-version'], 4000);
  return out?.match(/ffmpeg version (\S+)/)?.[1];
}

function whisperStatus(deps: ToolsDeps, p: ReturnType<typeof managedPaths>, env: NodeJS.ProcessEnv): ToolStatus {
  const configured = env['WHISPER_BIN']?.trim();
  if (configured && configured !== p.whisper) {
    const found = resolveCli(configured, deps.env, { exists: deps.exists, platform: deps.platform });
    return found
      ? { id: 'whisper', installed: true, source: 'configured', path: found, detail: 'Set in Settings.' }
      : { id: 'whisper', installed: false, source: 'configured', path: configured, detail: `Settings point at ${configured}, which is not there.` };
  }
  if (deps.exists(p.whisper)) return { id: 'whisper', installed: true, source: 'managed', path: p.whisper, detail: 'Managed by Hornbook.' };
  const onPath = resolveCli('whisper-cli', deps.env, { exists: deps.exists, platform: deps.platform });
  if (onPath) return { id: 'whisper', installed: true, source: 'system', path: onPath, detail: 'Found on PATH.' };
  return { id: 'whisper', installed: false, source: 'none', detail: 'whisper.cpp turns a recording into text on this computer.' };
}

function whisperModelStatus(deps: ToolsDeps, p: ReturnType<typeof managedPaths>, env: NodeJS.ProcessEnv): ToolStatus {
  const managed = managedWhisperModels(deps.listDir(p.whisperModels));
  const configured = env['WHISPER_MODEL']?.trim();
  if (configured && !managed.some((m) => p.whisperModel(m) === configured)) {
    return deps.exists(configured)
      ? { id: 'whisper-model', installed: true, source: 'configured', path: configured, detail: 'Set in Settings.' }
      : { id: 'whisper-model', installed: false, source: 'configured', path: configured, detail: `Settings point at ${configured}, which is not there.` };
  }
  if (managed.length > 0) {
    const preferred = preferredWhisperModel(managed) ?? managed[0];
    return { id: 'whisper-model', installed: true, source: 'managed', path: p.whisperModel(preferred), version: preferred, models: managed, detail: `Managed: ${managed.join(', ')}.` };
  }
  return { id: 'whisper-model', installed: false, source: 'none', detail: 'A ggml model file for whisper.cpp.' };
}

async function ollamaStatus(deps: ToolsDeps, p: ReturnType<typeof managedPaths>, opts: StatusOptions): Promise<ToolStatus> {
  const configuredHost = ollamaHost({ OLLAMA_HOST: opts.env['OLLAMA_HOST'] });
  const external = configuredHost !== opts.managedOllama.host ? await ollamaVersion(deps, configuredHost) : undefined;
  if (external) {
    return { id: 'ollama', installed: true, source: 'external', path: configuredHost, version: external, detail: `Running at ${configuredHost}; Hornbook uses it.` };
  }
  if (deps.exists(p.ollama)) {
    const running = opts.managedOllama.running ? await ollamaVersion(deps, opts.managedOllama.host) : undefined;
    return {
      id: 'ollama',
      installed: true,
      source: 'managed',
      path: p.ollama,
      version: running,
      running: !!running,
      detail: running ? `Hornbook runs its own Ollama at ${opts.managedOllama.host}.` : 'Managed copy present; it starts with Hornbook.',
    };
  }
  return { id: 'ollama', installed: false, source: 'none', detail: 'Runs the writing model on this computer or the home network.' };
}

async function ollamaVersion(deps: ToolsDeps, host: string): Promise<string | undefined> {
  try {
    const res = await deps.fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === 'string' ? json.version : 'unknown';
  } catch {
    return undefined;
  }
}

async function ollamaModelStatus(deps: ToolsDeps, ollama: ToolStatus): Promise<ToolStatus> {
  const host = ollama.installed && (ollama.source === 'external' || ollama.running) ? ollama.source === 'external' ? ollama.path : undefined : undefined;
  const managedHost = ollama.source === 'managed' && ollama.running ? ollama.detail.match(/at (http\S+)\.$/)?.[1] : undefined;
  const target = host ?? managedHost;
  if (!target) {
    return { id: 'ollama-model', installed: false, source: 'none', detail: ollama.installed ? 'Ollama is not running yet.' : 'Needs Ollama first.' };
  }
  try {
    const res = await deps.fetch(`${target}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { id: 'ollama-model', installed: false, source: 'none', detail: `Ollama answered HTTP ${res.status}.` };
    const json = (await res.json()) as { models?: { name?: string; capabilities?: unknown }[] };
    const names = (json.models ?? []).filter((m) => typeof m.name === 'string' && canComplete(m)).map((m) => m.name as string);
    if (names.length === 0) return { id: 'ollama-model', installed: false, source: 'none', detail: 'No chat model pulled yet.' };
    return { id: 'ollama-model', installed: true, source: ollama.source === 'external' ? 'external' : 'managed', models: names, detail: `Pulled: ${names.join(', ')}.` };
  } catch (err) {
    return { id: 'ollama-model', installed: false, source: 'none', detail: `Cannot list models: ${(err as Error).message.slice(0, 120)}` };
  }
}

// ── The machine ──────────────────────────────────────────────────────────────

export async function machineInfo(deps: ToolsDeps): Promise<MachineInfo> {
  const out = await deps.run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 4000);
  const line = out?.split('\n').map((l) => l.trim()).find(Boolean);
  const m = line?.match(/^(.+?),\s*(\d+)\s*$/);
  return {
    platform: deps.platform,
    arch: deps.arch,
    ramMb: deps.totalMemMb,
    gpu: m ? { name: m[1].trim(), vramMb: Number(m[2]) } : undefined,
  };
}

export function toolsRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return toolsDir(env, platform);
}

export { join as joinPath };
