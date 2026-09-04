import { describe, expect, it, vi } from 'vitest';
import { applyManagedUpdateEntries, machineInfo, managedWhisperModels, toolStatuses, toolsEnv, type ToolsDeps } from './tools.ts';
import type { ToolStatus } from '../src/lib/api-types.ts';

const DIR = 'C:\\t';
const win = (over: Partial<ToolsDeps> = {}): ToolsDeps => ({
  env: { HORNBOOK_TOOLS: DIR, PATH: 'C:\\bin', PATHEXT: '.EXE' },
  platform: 'win32',
  arch: 'x64',
  exists: () => false,
  listDir: () => [],
  fetch: vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch,
  run: async () => undefined,
  totalMemMb: 64000,
  ...over,
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('toolsEnv', () => {
  it('leaves the environment alone when nothing is managed', () => {
    const out = toolsEnv({ PATH: 'C:\\bin' }, { dir: DIR, platform: 'win32', exists: () => false, listDir: () => [] });
    expect(out).toEqual({ PATH: 'C:\\bin' });
  });

  it('prepends the managed ffmpeg to whichever PATH key exists', () => {
    const exists = (p: string) => p === 'C:\\t\\ffmpeg\\ffmpeg.exe';
    expect(toolsEnv({ Path: 'C:\\bin' }, { dir: DIR, platform: 'win32', exists, listDir: () => [] })).toEqual({ Path: 'C:\\t\\ffmpeg;C:\\bin' });
    expect(toolsEnv({}, { dir: DIR, platform: 'win32', exists, listDir: () => [] })).toEqual({ PATH: 'C:\\t\\ffmpeg' });
  });

  it('fills whisper and Ollama only where the user set nothing', () => {
    const exists = (p: string) => p === 'C:\\t\\whisper\\whisper-cli.exe';
    const listDir = () => ['ggml-tiny.bin', 'ggml-small.bin', 'notes.txt'];
    const filled = toolsEnv({}, { dir: DIR, platform: 'win32', exists, listDir, managedOllamaHost: 'http://127.0.0.1:11435' });
    expect(filled).toEqual({
      WHISPER_BIN: 'C:\\t\\whisper\\whisper-cli.exe',
      WHISPER_MODEL: 'C:\\t\\models\\whisper\\ggml-small.bin',
      OLLAMA_HOST: 'http://127.0.0.1:11435',
    });
    const kept = toolsEnv(
      { WHISPER_BIN: 'D:\\my\\whisper.exe', WHISPER_MODEL: 'D:\\my\\model.bin', OLLAMA_HOST: 'http://nas:11434' },
      { dir: DIR, platform: 'win32', exists, listDir, managedOllamaHost: 'http://127.0.0.1:11435' },
    );
    expect(kept).toEqual({ WHISPER_BIN: 'D:\\my\\whisper.exe', WHISPER_MODEL: 'D:\\my\\model.bin', OLLAMA_HOST: 'http://nas:11434' });
  });
});

describe('managedWhisperModels', () => {
  it('reads model names from ggml file names only', () => {
    expect(managedWhisperModels(['ggml-large-v3-turbo.bin', 'ggml-small.bin.part', 'README'])).toEqual(['large-v3-turbo']);
  });
});

describe('managed tool updates', () => {
  it('marks only Hornbook-managed tools whose pinned release moved', () => {
    const rows: ToolStatus[] = [
      { id: 'ffmpeg', installed: true, source: 'managed', detail: '' },
      { id: 'whisper', installed: true, source: 'system', detail: '' },
      { id: 'ollama', installed: true, source: 'managed', detail: '' },
    ];
    applyManagedUpdateEntries(rows, [
      { tool: 'ffmpeg', version: 'old-ffmpeg' },
      { tool: 'whisper', version: 'old-whisper' },
      { tool: 'ollama', version: '0.0.1' },
    ]);
    expect(rows[0].update).toMatchObject({ installedVersion: 'old-ffmpeg', targetVersion: 'n9.0' });
    expect(rows[1].update).toBeUndefined();
    expect(rows[2].update).toMatchObject({ installedVersion: '0.0.1' });
  });
});

describe('toolStatuses', () => {
  const managedOllama = { host: 'http://127.0.0.1:11435', running: false };

  it('reports everything missing on a bare machine', async () => {
    const rows = await toolStatuses(win(), { env: {}, managedOllama });
    expect(rows.map((r) => r.id)).toEqual(['ffmpeg', 'whisper', 'whisper-model', 'ollama', 'ollama-model']);
    expect(rows.every((r) => !r.installed && r.source === 'none')).toBe(true);
    expect(rows[4].detail).toMatch(/Needs Ollama first/);
  });

  it('finds ffmpeg on PATH with its version, and managed copies in the tools folder', async () => {
    const files = new Set(['C:\\bin\\ffmpeg.EXE', 'C:\\t\\whisper\\whisper-cli.exe']);
    const deps = win({
      exists: (p) => files.has(p),
      listDir: (d) => (d === 'C:\\t\\models\\whisper' ? ['ggml-small.bin', 'ggml-tiny.bin'] : []),
      run: async (cmd) => (cmd.endsWith('ffmpeg.EXE') ? 'ffmpeg version 9.0-full_build Copyright' : undefined),
    });
    const [ffmpeg, whisper, model] = await toolStatuses(deps, { env: {}, managedOllama });
    expect(ffmpeg).toMatchObject({ installed: true, source: 'system', path: 'C:\\bin\\ffmpeg.EXE', version: '9.0-full_build' });
    expect(whisper).toMatchObject({ installed: true, source: 'managed', path: 'C:\\t\\whisper\\whisper-cli.exe' });
    expect(model).toMatchObject({ installed: true, source: 'managed', version: 'small', models: ['small', 'tiny'] });
  });

  it('respects a configured whisper path, installed or dangling', async () => {
    const ok = await toolStatuses(win({ exists: (p) => p === 'D:\\w\\whisper-cli.exe' }), { env: { WHISPER_BIN: 'D:\\w\\whisper-cli.exe' }, managedOllama });
    expect(ok[1]).toMatchObject({ installed: true, source: 'configured', path: 'D:\\w\\whisper-cli.exe' });
    const gone = await toolStatuses(win(), { env: { WHISPER_BIN: 'D:\\w\\whisper-cli.exe', WHISPER_MODEL: 'D:\\w\\m.bin' }, managedOllama });
    expect(gone[1]).toMatchObject({ installed: false, source: 'configured' });
    expect(gone[2]).toMatchObject({ installed: false, source: 'configured' });
  });

  it('uses an external Ollama and lists its chat models, hiding embedders', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'http://127.0.0.1:11434/api/version') return jsonResponse({ version: '0.33.3' });
      if (u === 'http://127.0.0.1:11434/api/tags') {
        return jsonResponse({ models: [{ name: 'qwen2.5:7b', capabilities: ['completion'] }, { name: 'bge-m3:latest', capabilities: ['embedding'] }] });
      }
      throw new Error('unexpected ' + u);
    }) as unknown as typeof fetch;
    const [, , , ollama, model] = await toolStatuses(win({ fetch: fetchImpl }), { env: {}, managedOllama });
    expect(ollama).toMatchObject({ installed: true, source: 'external', path: 'http://127.0.0.1:11434', version: '0.33.3' });
    expect(model).toMatchObject({ installed: true, source: 'external', models: ['qwen2.5:7b'] });
  });

  it('reports a managed Ollama that is installed but not running', async () => {
    const deps = win({ exists: (p) => p === 'C:\\t\\ollama\\ollama.exe' });
    const [, , , ollama, model] = await toolStatuses(deps, { env: {}, managedOllama });
    expect(ollama).toMatchObject({ installed: true, source: 'managed', running: false });
    expect(model).toMatchObject({ installed: false });
    expect(model.detail).toMatch(/not running/);
  });

  it('lists models from the managed Ollama when it runs', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:11434/')) throw new Error('ECONNREFUSED');
      if (u === 'http://127.0.0.1:11435/api/version') return jsonResponse({ version: '0.33.3' });
      if (u === 'http://127.0.0.1:11435/api/tags') return jsonResponse({ models: [{ name: 'qwen2.5:3b' }] });
      throw new Error('unexpected ' + u);
    }) as unknown as typeof fetch;
    const deps = win({ exists: (p) => p === 'C:\\t\\ollama\\ollama.exe', fetch: fetchImpl });
    const [, , , ollama, model] = await toolStatuses(deps, { env: {}, managedOllama: { ...managedOllama, running: true } });
    expect(ollama).toMatchObject({ installed: true, source: 'managed', running: true, version: '0.33.3' });
    expect(model).toMatchObject({ installed: true, source: 'managed', models: ['qwen2.5:3b'] });
  });
});

describe('machineInfo', () => {
  it('parses nvidia-smi and survives its absence', async () => {
    const withGpu = await machineInfo(win({ run: async () => 'NVIDIA GeForce RTX 5060 Laptop GPU, 8151\n' }));
    expect(withGpu).toEqual({ platform: 'win32', arch: 'x64', ramMb: 64000, gpu: { name: 'NVIDIA GeForce RTX 5060 Laptop GPU', vramMb: 8151 } });
    const without = await machineInfo(win());
    expect(without.gpu).toBeUndefined();
  });
});
