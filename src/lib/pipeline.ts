// How a recording becomes a conspect: two jobs, each run in one place.
// Places are the three kinds of connector: a local CLI, a box on the LAN
// (Ollama), or a remote API. Not every job has every place.

import type { ConnectionKey } from './api-types';

export type PipelineJob = 'transcribe' | 'extract';
export type PlaceId = 'skip' | 'cli' | 'lan' | 'cloud';
export type DriverId = 'skip' | 'whisper-cli' | 'openai' | 'ollama' | 'anthropic';

export interface PipelinePath {
  job: PipelineJob;
  place: PlaceId;
  driver: DriverId;
  defaultModel: string;
  /** Extra connection fields besides the model itself. */
  connections: readonly ConnectionKey[];
  modelKind: 'file' | 'name';
}

export const PIPELINE_PATHS: readonly PipelinePath[] = [
  {
    job: 'transcribe',
    place: 'skip',
    driver: 'skip',
    defaultModel: '-',
    connections: [],
    modelKind: 'name',
  },
  {
    job: 'transcribe',
    place: 'cli',
    driver: 'whisper-cli',
    defaultModel: 'ggml-base.bin',
    connections: ['WHISPER_BIN'],
    modelKind: 'file',
  },
  {
    job: 'transcribe',
    place: 'cloud',
    driver: 'openai',
    defaultModel: 'gpt-4o-transcribe',
    connections: ['OPENAI_API_KEY'],
    modelKind: 'name',
  },
  {
    job: 'extract',
    place: 'lan',
    driver: 'ollama',
    defaultModel: 'llama3.1',
    connections: ['OLLAMA_HOST'],
    modelKind: 'name',
  },
  {
    job: 'extract',
    place: 'cloud',
    driver: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    connections: ['ANTHROPIC_API_KEY'],
    modelKind: 'name',
  },
  {
    job: 'extract',
    place: 'cloud',
    driver: 'openai',
    defaultModel: 'gpt-4o',
    connections: ['OPENAI_API_KEY'],
    modelKind: 'name',
  },
];

export const PLACES_FOR: Record<PipelineJob, readonly PlaceId[]> = {
  transcribe: ['skip', 'cli', 'cloud'],
  extract: ['lan', 'cloud'],
};

export function canHear(driver: string): boolean {
  return driver === 'whisper-cli' || driver === 'openai';
}

export function pathsFor(job: PipelineJob, place?: PlaceId): readonly PipelinePath[] {
  return PIPELINE_PATHS.filter((p) => p.job === job && (place === undefined || p.place === place));
}

export function pathFor(job: PipelineJob, driver: string): PipelinePath | undefined {
  return PIPELINE_PATHS.find((p) => p.job === job && p.driver === driver);
}

export function placeFor(job: PipelineJob, driver: string): PlaceId {
  return pathFor(job, driver)?.place ?? PLACES_FOR[job][0];
}

export function defaultPath(job: PipelineJob, place: PlaceId): PipelinePath {
  return pathsFor(job, place)[0] ?? PIPELINE_PATHS.find((p) => p.job === job)!;
}

/** Anthropic keys are `sk-ant-…`; other `sk-…` keys are treated as OpenAI-compatible. */
export function cloudDriverFromKey(value: string): 'anthropic' | 'openai' | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v.startsWith('sk-ant-')) return 'anthropic';
  if (v.startsWith('sk-')) return 'openai';
  return undefined;
}

/**
 * Switch place without inventing a model name. Keep whatever the user already
 * typed, unless it is empty, the skip sentinel, or the previous path's default.
 */
export function adoptPlace(
  job: PipelineJob,
  place: PlaceId,
  cfg: { driver: string; model: string },
): void {
  const previous = pathFor(job, cfg.driver);
  const next = defaultPath(job, place);
  const keep =
    cfg.model &&
    cfg.model !== '-' &&
    cfg.model !== previous?.defaultModel &&
    place !== 'skip';
  if (place === 'cloud' && (cfg.driver === 'openai' || cfg.driver === 'anthropic')) {
    // already on a cloud API — don't bounce Anthropic ↔ OpenAI
  } else {
    cfg.driver = next.driver;
  }
  cfg.model = place === 'skip' ? '-' : keep ? cfg.model : '';
}

/** Hosts that do not need a stored value — a built-in default is enough to try. */
export const OPTIONAL_CONNECTIONS: ReadonlySet<ConnectionKey> = new Set(['OLLAMA_HOST']);
