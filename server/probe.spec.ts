import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canComplete,
  filterApiModels,
  modelIdsFromList,
  parseProbeInput,
  probePipeline,
  type ProbeDeps,
} from './probe.ts';

function deps(fetchImpl: ProbeDeps['fetch'], exists: ProbeDeps['exists'] = () => false): ProbeDeps {
  return { fetch: fetchImpl, exists, env: {} };
}

describe('parseProbeInput', () => {
  it('rejects a body without a job', () => {
    expect(() => parseProbeInput({ driver: 'openai', model: 'x' })).toThrow(/job/);
  });
});

describe('probePipeline', () => {
  it('checks the explicitly selected Whisper file instead of a legacy fallback, including missing relative files', async () => {
    const model = 'selected.bin';
    const options: ProbeDeps = { fetch: vi.fn(), exists: (path) => path !== model, env: { WHISPER_BIN: 'whisper-cli', WHISPER_MODEL: 'legacy.bin' } };
    const result = await probePipeline({ job: 'transcribe', driver: 'whisper-cli', model }, tmpdir(), options);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('No model file at selected.bin.');
    options.exists = () => true;
    const ready = await probePipeline({ job: 'transcribe', driver: 'whisper-cli', model }, tmpdir(), options);
    expect(ready.detail).toContain('selected.bin');
    expect(ready.detail).not.toContain('legacy.bin');
  });
  it('accepts a coding CLI found on PATH and names the file it resolved to', async () => {
    const onPath: ProbeDeps = { fetch: vi.fn(), exists: () => true, env: { PATH: '/usr/local/bin' } };
    const claude = await probePipeline(
      { job: 'extract', driver: 'claude-cli', model: 'sonnet' },
      tmpdir(),
      onPath,
    );
    expect(claude.ok).toBe(true);
    expect(claude.detail).toMatch(/Claude Code CLI · \S*claude\S* · sonnet/);
    const grok = await probePipeline(
      { job: 'extract', driver: 'grok-cli', model: 'grok-4.6' },
      tmpdir(),
      onPath,
    );
    expect(grok.ok).toBe(true);
    expect(grok.detail).toMatch(/Grok CLI · \S*grok\S* · grok-4\.6/);
    const kimi = await probePipeline({ job: 'extract', driver: 'kimi-cli', model: '-' }, tmpdir(), onPath);
    expect(kimi.ok).toBe(true);
    expect(kimi.detail).toMatch(/Kimi CLI · \S*kimi\S* · CLI default/);
  });

  it('fails a coding CLI that is not on PATH', async () => {
    const result = await probePipeline(
      { job: 'extract', driver: 'codex-cli', model: '-' },
      tmpdir(),
      { fetch: vi.fn(), exists: () => false, env: { PATH: '/usr/local/bin' } },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/codex CLI is not on PATH.*CODEX_BIN/);
  });

  it('fails a coding CLI when the configured path is missing', async () => {
    const result = await probePipeline(
      { job: 'extract', driver: 'claude-cli', model: 'sonnet' },
      tmpdir(),
      { fetch: vi.fn(), exists: () => false, env: { CLAUDE_BIN: 'C:\\missing\\claude.exe' } },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/No claude CLI/);
  });

  it('fails whisper when the binary path is missing', async () => {
    const result = await probePipeline(
      { job: 'transcribe', driver: 'whisper-cli', model: 'ggml-base.bin' },
      tmpdir(),
      deps(vi.fn()),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/whisper\.cpp binary/i);
  });

  it('accepts whisper when binary and model files exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornbook-probe-'));
    const bin = join(dir, 'whisper-cli.exe');
    const model = join(dir, 'ggml-base.bin');
    writeFileSync(bin, '');
    writeFileSync(model, '');
    try {
      const result = await probePipeline(
        {
          job: 'transcribe',
          driver: 'whisper-cli',
          model,
          connections: { WHISPER_BIN: bin },
        },
        dir,
        deps(vi.fn(), (p) => p === bin || p === model),
      );
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a reachable Ollama without the named model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.2:latest' }] }),
    });
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: 'llama3.1' },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(false);
    expect(result.pick).toBeUndefined();
    expect(result.detail).toMatch(/not pulled|Pick one/);
    expect(result.models).toEqual(['llama3.2:latest']);
  });

  it('lists pulled Ollama models so the user can pick one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.1:latest' }, { name: 'qwen2.5:7b' }] }),
    });
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: '' },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(false);
    // A found list is not a failure: the UI must not paint it red.
    expect(result.pick).toBe(true);
    expect(result.models).toEqual(['llama3.1:latest', 'qwen2.5:7b']);
  });

  it('passes skip-hearing without touching the network', async () => {
    const fetchImpl = vi.fn();
    const result = await probePipeline(
      { job: 'transcribe', driver: 'skip', model: '-' },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing OpenAI key without calling the network', async () => {
    const fetchImpl = vi.fn();
    const result = await probePipeline(
      { job: 'extract', driver: 'openai', model: 'gpt-4o' },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists models from an OpenAI key and does not invent a pick', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-4o-2024-08-06' },
          { id: 'whisper-1' },
          { id: 'gpt-4o-transcribe' },
          { id: 'text-embedding-3-small' },
        ],
      }),
    });
    const result = await probePipeline(
      { job: 'extract', driver: 'openai', model: '', connections: { OPENAI_API_KEY: 'sk-test-1234567890' } },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(false);
    expect(result.pick).toBe(true);
    expect(result.models).toEqual(['gpt-4o']);
    expect(result.detail).toMatch(/Pick one/i);
  });

  it('lists only hearing models for an OpenAI transcribe probe', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }, { id: 'gpt-4o-mini-transcribe' }],
      }),
    });
    const result = await probePipeline(
      {
        job: 'transcribe',
        driver: 'openai',
        model: '',
        connections: { OPENAI_API_KEY: 'sk-test-1234567890' },
      },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.models).toEqual(['whisper-1', 'gpt-4o-mini-transcribe']);
  });

  it('lists Anthropic models from /v1/models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-haiku-4-5' }],
      }),
    });
    const result = await probePipeline(
      {
        job: 'extract',
        driver: 'anthropic',
        model: 'claude-sonnet-4-6',
        connections: { ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' },
      },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5']);
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/v1\/models/);
  });
});

describe('filterApiModels', () => {
  it('drops dated aliases and non-job models without keeping a catalog', () => {
    expect(
      filterApiModels('extract', [
        'gpt-4o',
        'gpt-4o-2024-08-06',
        'whisper-1',
        'text-embedding-3-large',
        'o4-mini',
      ]),
    ).toEqual(['gpt-4o', 'o4-mini']);
    expect(filterApiModels('transcribe', ['gpt-4o', 'whisper-1', 'gpt-4o-transcribe'])).toEqual([
      'whisper-1',
      'gpt-4o-transcribe',
    ]);
    expect(modelIdsFromList({ data: [{ id: 'a' }, { id: 'a' }, { name: 'nope' }] })).toEqual(['a']);
  });
});

describe('Ollama capabilities', () => {
  const tags = { models: [{ name: 'qwen2.5:7b' }, { name: 'bge-m3:latest' }] };
  const show: Record<string, unknown> = {
    'qwen2.5:7b': { capabilities: ['completion', 'tools'] },
    'bge-m3:latest': { capabilities: ['embedding'] },
  };
  const ollamaFetch = (): ProbeDeps['fetch'] =>
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return { ok: true, json: async () => tags };
      if (u.endsWith('/api/show')) {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        return { ok: true, json: async () => show[model] };
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as ProbeDeps['fetch'];

  it('hides embedding-only models from the pick list', async () => {
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: '' },
      tmpdir(),
      deps(ollamaFetch()),
    );
    expect(result.ok).toBe(false);
    expect(result.models).toEqual(['qwen2.5:7b']);
  });

  it('refuses an embedding model as the writer', async () => {
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: 'bge-m3' },
      tmpdir(),
      deps(ollamaFetch()),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/embedding model/i);
    expect(result.models).toEqual(['qwen2.5:7b']);
  });

  it('accepts a chat model and says slides are skipped without vision', async () => {
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: 'qwen2.5:7b' },
      tmpdir(),
      deps(ollamaFetch()),
    );
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen2.5:7b']);
    expect(result.detail).toMatch(/slides skipped/);
  });

  it('asks /api/show for the chosen model because /api/tags leaves vision out', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b', capabilities: ['completion'] }] }) };
      }
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      return { ok: true, json: async () => ({ capabilities: model === 'gemma3:4b' ? ['completion', 'vision'] : [] }) };
    }) as unknown as ProbeDeps['fetch'];
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: 'gemma3:4b' },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/reads slides/);
  });

  it('says when the chosen model reads slides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'gemma3:4b', capabilities: ['completion', 'vision'] }] }),
    });
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: 'gemma3:4b' },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/reads slides/);
  });

  it('reads capabilities straight from /api/tags when the server lists them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen2.5:7b', capabilities: ['completion', 'tools'] },
          { name: 'bge-m3:latest', capabilities: ['embedding'] },
        ],
      }),
    });
    const result = await probePipeline(
      { job: 'extract', driver: 'ollama', model: '' },
      tmpdir(),
      deps(fetchImpl),
    );
    expect(result.models).toEqual(['qwen2.5:7b']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps every model when an older Ollama reports no capabilities', () => {
    expect(canComplete({})).toBe(true);
    expect(canComplete({ capabilities: ['completion'] })).toBe(true);
    expect(canComplete({ capabilities: ['embedding'] })).toBe(false);
  });
});
