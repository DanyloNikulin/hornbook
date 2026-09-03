// Cheap readiness check for one pipeline step. Does not run a lesson.
// Uses stored secrets plus any values the client just typed (not persisted).

import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ConnectionKey } from '../src/lib/api-types.ts';
import { pathFor, type PipelineJob } from '../src/lib/pipeline.ts';
import { pipelineEnv } from './secrets.ts';

export interface ProbeInput {
  job: PipelineJob;
  driver: string;
  model: string;
  connections?: Partial<Record<ConnectionKey, string>>;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  models?: string[];
}

export interface ProbeDeps {
  exists: (path: string) => boolean;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

const TIMEOUT_MS = 8000;

export function parseProbeInput(raw: unknown): ProbeInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid probe');
  const o = raw as Record<string, unknown>;
  if (o['job'] !== 'transcribe' && o['job'] !== 'extract') throw new Error('job must be transcribe or extract');
  if (typeof o['driver'] !== 'string' || !o['driver']) throw new Error('driver is required');
  if (o['model'] !== undefined && typeof o['model'] !== 'string') throw new Error('model must be a string');
  const connections: ProbeInput['connections'] = {};
  const c = o['connections'];
  if (c && typeof c === 'object') {
    for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) connections[k as ConnectionKey] = v.trim();
    }
  }
  return {
    job: o['job'],
    driver: o['driver'],
    model: typeof o['model'] === 'string' ? o['model'].trim() : '',
    connections,
  };
}

export async function probePipeline(
  input: ProbeInput,
  journalDir: string,
  deps: ProbeDeps = { exists: existsSync, fetch, env: process.env },
): Promise<ProbeResult> {
  const path = pathFor(input.job, input.driver);
  if (!path) return { ok: false, detail: `Unknown ${input.job} driver "${input.driver}".` };
  const env = { ...pipelineEnv(journalDir, deps.env), ...input.connections };

  if (path.driver === 'skip') {
    return { ok: true, detail: 'Hearing is skipped. Paste a transcript on Add.' };
  }
  if (path.driver === 'whisper-cli') return probeWhisper(input.model, env, deps);
  if (path.driver === 'ollama') return probeOllama(input.model, env, deps);
  if (path.driver === 'openai') return probeOpenAi(input.job, input.model, env, deps);
  if (path.driver === 'anthropic') return probeAnthropic(input.model, env, deps);
  return { ok: false, detail: `No probe for driver "${path.driver}".` };
}

function probeWhisper(model: string, env: NodeJS.ProcessEnv, deps: ProbeDeps): ProbeResult {
  const bin = env['WHISPER_BIN']?.trim();
  if (!bin) return { ok: false, detail: 'Set the path to the whisper.cpp binary (whisper-cli).' };
  if ((isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) && !deps.exists(bin)) {
    return { ok: false, detail: `No binary at ${bin}.` };
  }
  const modelPath = env['WHISPER_MODEL']?.trim() || model;
  if (!modelPath) return { ok: false, detail: 'Set the path to a whisper.cpp model file.' };
  if ((isAbsolute(modelPath) || modelPath.includes('/') || modelPath.includes('\\')) && !deps.exists(modelPath)) {
    return { ok: false, detail: `No model file at ${modelPath}.` };
  }
  return { ok: true, detail: `whisper.cpp · ${bin} · ${modelPath}` };
}

async function probeOllama(model: string, env: NodeJS.ProcessEnv, deps: ProbeDeps): Promise<ProbeResult> {
  const host = (env['OLLAMA_HOST']?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const res = await deps.fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, detail: `Ollama at ${host} answered HTTP ${res.status}.` };
    const json = (await res.json()) as { models?: OllamaModel[] };
    const listed = (json.models ?? []).filter((m) => typeof m.name === 'string' && m.name);
    const pulled = listed.map((m) => m.name);
    if (pulled.length === 0) {
      return { ok: false, detail: `Ollama is up at ${host}, but no models are pulled.`, models: [] };
    }
    const names = await completionModels(host, listed, deps);
    if (names.length === 0) {
      return {
        ok: false,
        detail: `Ollama at ${host} has ${pulled.length} model(s), but only embedding models. Pull a chat model to write conspects.`,
        models: [],
      };
    }
    if (!model) {
      return {
        ok: false,
        detail: `Ollama is up at ${host}. Pick one of ${names.length} pulled model(s).`,
        models: names,
      };
    }
    const has = (list: readonly string[]): boolean => list.some((n) => n === model || n.startsWith(`${model}:`));
    if (!has(pulled)) {
      return {
        ok: false,
        detail: `"${model}" is not pulled on ${host}. Pick one from the list.`,
        models: names,
      };
    }
    if (!has(names)) {
      return {
        ok: false,
        detail: `"${model}" is an embedding model; it cannot write text. Pick a chat model from the list.`,
        models: names,
      };
    }
    return { ok: true, detail: `Ollama at ${host} · ${model}`, models: names };
  } catch (err) {
    return { ok: false, detail: `Cannot reach Ollama at ${host}. ${explain(err)}` };
  }
}

interface OllamaModel {
  name: string;
  capabilities?: unknown;
}

/**
 * Drop models that cannot write text. Ollama reports `capabilities` —
 * "completion" for chat models, "embedding" alone for bge-m3 and friends —
 * in /api/tags on recent servers and from POST /api/show since 0.6.5. An
 * older server (no field anywhere) or a failed lookup keeps the model: the
 * point is to hide embedders, not to second-guess Ollama.
 */
async function completionModels(
  host: string,
  models: readonly OllamaModel[],
  deps: ProbeDeps,
): Promise<string[]> {
  const keep = await Promise.all(
    models.map(async (m) => {
      if (Array.isArray(m.capabilities)) return canComplete(m);
      try {
        const res = await deps.fetch(`${host}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.name }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return true;
        return canComplete((await readJson(res)) as { capabilities?: unknown });
      } catch {
        return true;
      }
    }),
  );
  return models.filter((_, i) => keep[i]).map((m) => m.name);
}

/** True unless /api/show lists capabilities without "completion". */
export function canComplete(show: { capabilities?: unknown }): boolean {
  const caps = show.capabilities;
  return !Array.isArray(caps) || caps.includes('completion');
}

async function probeOpenAi(job: PipelineJob, model: string, env: NodeJS.ProcessEnv, deps: ProbeDeps): Promise<ProbeResult> {
  const key = env['OPENAI_API_KEY']?.trim();
  if (!key) return { ok: false, detail: 'Set an OpenAI API key.' };
  try {
    const res = await deps.fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, detail: 'OpenAI rejected the key (401).' };
    if (!res.ok) return { ok: false, detail: `OpenAI answered HTTP ${res.status}.` };
    const names = filterApiModels(job, modelIdsFromList(await readJson(res)));
    return listedResult('OpenAI', job, model, names);
  } catch (err) {
    return { ok: false, detail: `Cannot reach OpenAI. ${explain(err)}` };
  }
}

async function probeAnthropic(model: string, env: NodeJS.ProcessEnv, deps: ProbeDeps): Promise<ProbeResult> {
  const key = env['ANTHROPIC_API_KEY']?.trim();
  if (!key) return { ok: false, detail: 'Set an Anthropic API key.' };
  try {
    const res = await deps.fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, detail: 'Anthropic rejected the key (401).' };
    if (!res.ok) return { ok: false, detail: `Anthropic answered HTTP ${res.status}.` };
    const names = filterApiModels('extract', modelIdsFromList(await readJson(res)));
    return listedResult('Anthropic', 'extract', model, names);
  } catch (err) {
    return { ok: false, detail: `Cannot reach Anthropic. ${explain(err)}` };
  }
}

function listedResult(who: string, job: PipelineJob, model: string, names: string[]): ProbeResult {
  if (!model) {
    return {
      ok: false,
      detail: names.length
        ? `${who} accepted the key. Pick one of ${names.length} model(s).`
        : `${who} accepted the key. Type a model name.`,
      models: names,
    };
  }
  return { ok: true, detail: `${who} · ${job} · ${model}`, models: names };
}

async function readJson(res: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** OpenAI- and Anthropic-style `{ data: [{ id }] }`. */
export function modelIdsFromList(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const TRANSCRIBE_RE = /whisper|transcribe/i;
const EXTRACT_SKIP_RE =
  /whisper|transcribe|tts|dall-e|chatgpt-image|gpt-image|embedding|moderation|realtime|audio|sora|babbage|davinci|ada-|text-similarity|text-search|code-search/i;
const DATED_RE = /^(.*)-\d{4}-\d{2}-\d{2}(?:-\w+)?$/;

/**
 * Keep names this job can actually use. Dated snapshot aliases are dropped
 * when the undated id is also present, so the list stays short without
 * Hornbook owning a catalog of model names.
 */
export function filterApiModels(job: PipelineJob, ids: readonly string[]): string[] {
  const relevant = ids.filter((id) =>
    job === 'transcribe' ? TRANSCRIBE_RE.test(id) : !EXTRACT_SKIP_RE.test(id),
  );
  const set = new Set(relevant);
  return relevant.filter((id) => {
    const m = id.match(DATED_RE);
    return !m || !set.has(m[1]!);
  });
}

function explain(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'Timed out.';
  return (e.message ?? String(err)).slice(0, 200);
}
