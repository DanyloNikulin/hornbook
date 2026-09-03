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

export type JobKind = 'process' | 'cheatsheet' | 'review-topics';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

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
  /** Set by a successful process job. */
  result?: { slug?: string; id?: string };
  error?: string;
}

export interface StartProcessJob {
  kind: 'process';
  filename: string;
  base64: string;
  date: string;
  from?: 'video' | 'audio' | 'transcript' | 'json';
}

export interface StartCheatsheetJob {
  kind: 'cheatsheet';
  force?: boolean;
}

export interface StartReviewJob {
  kind: 'review-topics';
}

export type StartJob = StartProcessJob | StartCheatsheetJob | StartReviewJob;

// ── Settings ────────────────────────────────────────────────────────────────

/** Connection values the pipeline reads from the environment. */
export const CONNECTION_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_HOST',
  'WHISPER_BIN',
  'WHISPER_MODEL',
  'CLAUDE_MODEL',
] as const;
export type ConnectionKey = (typeof CONNECTION_KEYS)[number];

export const SECRET_KEYS: readonly ConnectionKey[] = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

export interface ConnectionView {
  /** True when a value is stored (secrets never leave the server). */
  set: boolean;
  /** Last characters of a secret, or the full value of a non-secret. */
  hint: string;
  /** Where the value comes from when set. */
  source?: 'journal' | 'environment';
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
