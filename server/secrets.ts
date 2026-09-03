// Connection values (API keys, local endpoints) stored in the journal folder
// as secrets.json, which is gitignored. They never leave the server: the API
// reports only whether a value is set plus a short hint, and the job runner
// injects them into the pipeline's environment.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECTION_KEYS,
  SECRET_KEYS,
  type ConnectionKey,
  type ConnectionView,
} from '../src/lib/api-types.ts';

export type Secrets = Partial<Record<ConnectionKey, string>>;

export function secretsPath(journalDir: string): string {
  return join(journalDir, 'secrets.json');
}

export function readSecrets(journalDir: string): Secrets {
  const path = secretsPath(journalDir);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const out: Secrets = {};
    for (const key of CONNECTION_KEYS) {
      const v = raw[key];
      if (typeof v === 'string' && v.trim()) out[key] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSecrets(journalDir: string, secrets: Secrets): void {
  const clean: Secrets = {};
  for (const key of CONNECTION_KEYS) {
    const v = secrets[key];
    if (v && v.trim()) clean[key] = v.trim();
  }
  writeFileSync(secretsPath(journalDir), JSON.stringify(clean, null, 2) + '\n', 'utf8');
}

/**
 * Apply an update: strings store, null clears, missing keys stay.
 */
export function updateSecrets(
  journalDir: string,
  patch: Partial<Record<ConnectionKey, string | null>>,
): Secrets {
  const next = { ...readSecrets(journalDir) };
  for (const key of CONNECTION_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined || !v.trim()) delete next[key];
    else next[key] = v.trim();
  }
  writeSecrets(journalDir, next);
  return next;
}

/** Environment for a pipeline child: process env, then journal secrets on top. */
export function pipelineEnv(journalDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...readSecrets(journalDir), HORNBOOK_JOURNAL: journalDir };
}

export function connectionViews(journalDir: string, base: NodeJS.ProcessEnv = process.env): Record<ConnectionKey, ConnectionView> {
  const stored = readSecrets(journalDir);
  const out = {} as Record<ConnectionKey, ConnectionView>;
  for (const key of CONNECTION_KEYS) {
    const fromJournal = stored[key];
    const fromEnv = base[key];
    const value = fromJournal ?? fromEnv;
    if (!value) {
      out[key] = { set: false, hint: '' };
      continue;
    }
    const secret = SECRET_KEYS.includes(key);
    out[key] = {
      set: true,
      hint: secret ? `…${value.slice(-4)}` : value,
      source: fromJournal ? 'journal' : 'environment',
    };
  }
  return out;
}
