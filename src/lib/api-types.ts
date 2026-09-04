// Shapes exchanged between the server API and the client. Shared so both
// sides compile against one definition.

import type { JournalConfigT, ProvidersT, SectionConfigT } from './journal-config';

export interface SectionSummary extends SectionConfigT {
  /** Explicit title or "Spanish → English". */
  label: string;
  flags: { target: string; learner: string };
  lessonCount: number;
}

export interface ConfigView {
  brand: JournalConfigT['brand'];
  providers: JournalConfigT['providers'];
  sections: SectionSummary[];
}

export interface ModeView {
  mode: 'local' | 'hosted';
  journal: string;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type JobKind = 'process' | 'cheatsheet' | 'review-topics' | 'setup';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type ProcessStageId = 'hearing' | 'slides' | 'writing' | 'checking';
export type JobStageStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

export interface JobStageView {
  id: ProcessStageId;
  status: JobStageStatus;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobView {
  id: string;
  section: string;
  kind: JobKind;
  status: JobStatus;
  /** Human label, e.g. the uploaded file name. */
  label: string;
  log: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Set by a successful process job (slug, id) or setup job (tool, path, version). */
  result?: { slug?: string; id?: string; tool?: string; path?: string; version?: string };
  error?: string;
  /** Last progress line of a setup job. */
  progress?: JobProgress;
  /** Structured progress for lesson-processing jobs. */
  stages?: JobStageView[];
}

export interface JobProgress {
  pct: number;
  bytes?: number;
  total?: number;
  stage?: string;
}

export interface StartProcessJob {
  kind: 'process';
  filename: string;
  base64: string;
  date: string;
  /** Optional human title chosen before extraction. */
  title?: string;
  from?: 'video' | 'audio' | 'transcript' | 'json';
}

export interface StartCheatsheetJob {
  kind: 'cheatsheet';
  force?: boolean;
}

export interface StartReviewJob {
  kind: 'review-topics';
}

export interface StartSetupJob {
  kind: 'setup';
  tool: ToolId;
  model?: string;
  variant?: WhisperVariant;
  /** Override the published checksum (tests). */
  sha256?: string;
}

export type StartJob = StartProcessJob | StartCheatsheetJob | StartReviewJob | StartSetupJob;

// ── Settings ────────────────────────────────────────────────────────────────

/** Connection values the pipeline reads from the environment. */
export const CONNECTION_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_HOST',
  'WHISPER_BIN',
  'WHISPER_MODEL',
] as const;
export type ConnectionKey = (typeof CONNECTION_KEYS)[number];

export const SECRET_KEYS: readonly ConnectionKey[] = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

export interface ConnectionView {
  /** True when a value is stored (secrets never leave the server). */
  set: boolean;
  /** Last characters of a secret, or the full value of a non-secret. */
  hint: string;
  /** Where the value comes from when set. */
  source?: 'journal' | 'environment' | 'managed';
}

export interface SettingsView {
  /** Journal-level defaults. */
  providers: ProvidersT;
  connections: Record<ConnectionKey, ConnectionView>;
}

export interface SettingsUpdate {
  providers?: ProvidersT;
  /** A string stores the value, null clears it, omitted keys stay. */
  connections?: Partial<Record<ConnectionKey, string | null>>;
}

export interface ProbeRequest {
  job: 'transcribe' | 'extract';
  driver: string;
  model: string;
  /** Typed-but-unsaved values; merged over secrets.json for this check only. */
  connections?: Partial<Record<ConnectionKey, string>>;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** Live inventory from this connection (Ollama tags, or the API's model list). Never a Hornbook catalog. */
  models?: string[];
  /**
   * The connection answered and `models` is what it offers, but no model is
   * chosen yet. Not a failure: the UI shows it as "pick one", not "not yet".
   */
  pick?: boolean;
}

// ── Setup inside the app: local tools ───────────────────────────────────────

export type ToolId = 'ffmpeg' | 'whisper' | 'whisper-model' | 'ollama' | 'ollama-model';
export type WhisperVariant = 'cpu' | 'cuda';

export interface ToolStatus {
  id: ToolId;
  installed: boolean;
  /** managed: in the tools folder; system: on PATH; configured: a path from Settings; external: an Ollama elsewhere. */
  source: 'managed' | 'system' | 'configured' | 'external' | 'none';
  path?: string;
  version?: string;
  /** Managed Ollama only: whether the child process is up. */
  running?: boolean;
  /** Model files or pulled models, where it applies. */
  models?: string[];
  detail: string;
}

export interface MachineInfo {
  platform: string;
  arch: string;
  ramMb: number;
  gpu?: { name: string; vramMb: number };
}

export interface Recommendation {
  whisperModel: string;
  whisperVariant: WhisperVariant;
  ollamaModel: string;
  note: string;
}

export interface DownloadPlan {
  tool: ToolId;
  /** archive: unpack into the tools folder; file: a model file; pull: Ollama pulls it itself. */
  kind: 'archive' | 'file' | 'pull';
  fileName: string;
  url: string;
  sizeBytes: number;
  /** Published by the release page; verified after the download. Ollama verifies its own pulls. */
  sha256?: string;
  source: string;
  version: string;
  model?: string;
  variant?: WhisperVariant;
}

export interface SetupPlanRequest {
  tool: ToolId;
  model?: string;
  variant?: WhisperVariant;
}

export interface SetupView {
  toolsDir: string;
  platform: string;
  machine: MachineInfo;
  recommend: Recommendation;
  tools: ToolStatus[];
  /** Terminal line per tool for people who prefer their package manager, or where no download exists. */
  commands: Record<ToolId, string | undefined>;
  whisperModels: { name: string; approxMb: number }[];
  ollamaModels: { name: string; approxMb: number; vision: boolean }[];
  ollama: { host: string; managed: boolean; running: boolean };
}
