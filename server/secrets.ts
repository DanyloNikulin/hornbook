// Connection values (API keys, local endpoints) stored in the journal folder
// as secrets.json, which is gitignored. They never leave the server: the API
// reports only whether a value is set plus a short hint, and the job runner
// injects them into the pipeline's environment.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECTION_KEYS,
  SECRET_KEYS,
  type ConnectionKey,
  type ConnectionView,
} from '../src/lib/api-types.ts';
import { toolsDir } from '../scripts/lib/tools.ts';
import { activeManagedHost } from './managed-ollama.ts';
import { toolsEnv } from './tools.ts';
import { checkedJournalPath, commitFiles, type FileChange } from '../scripts/lib/file-commit.ts';

export type Secrets = Partial<Record<ConnectionKey, string>>;

export function secretsPath(journalDir: string): string {
  return join(journalDir, 'secrets.json');
}

export function readSecrets(journalDir: string): Secrets {
  const path = checkedJournalPath(journalDir, 'secrets.json');
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== 'string')) throw new Error('Invalid connections');
    const out: Secrets = {};
    for (const key of CONNECTION_KEYS) {
      const v = raw[key];
      if (typeof v === 'string' && v.trim()) out[key] = v.trim();
    }
    return out;
  } catch {
    throw new Error('Stored connections are unreadable. Restore secrets.json from a backup before saving; the original file has been preserved.');
  }
}

export function writeSecrets(journalDir: string, secrets: Secrets): void {
  commitFiles(journalDir, () => ({ changes: [secretsChange(secrets)], result: undefined }));
}

function secretsChange(secrets: Secrets): FileChange {
  const clean: Secrets = {};
  for (const key of CONNECTION_KEYS) {
    const v = secrets[key];
    if (v && v.trim()) clean[key] = v.trim();
  }
  return { path: 'secrets.json', data: JSON.stringify(clean, null, 2) + '\n' };
}

/**
 * Apply an update: strings store, null clears, missing keys stay.
 */
export function updateSecrets(
  journalDir: string,
  patch: Partial<Record<ConnectionKey, string | null>>,
): Secrets {
  return commitFiles(journalDir, () => {
    const { next, change } = planSecretsUpdate(journalDir, patch);
    return { changes: [change], result: next };
  });
}

/** Called inside the same journal transaction as provider changes. */
export function planSecretsUpdate(journalDir: string, patch: Partial<Record<ConnectionKey, string | null>>): { next: Secrets; change: FileChange } {
  const next = { ...readSecrets(journalDir) };
  for (const key of CONNECTION_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined || !v.trim()) delete next[key];
    else next[key] = v.trim();
  }
  return { next, change: secretsChange(next) };
}

/**
 * Environment for a pipeline child: process env, journal secrets on top,
 * then the managed tools filling whatever is still unset.
 */
export function pipelineEnv(journalDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged = { ...base, ...readSecrets(journalDir), HORNBOOK_JOURNAL: journalDir };
  return toolsEnv(merged, { dir: toolsDir(base), managedOllamaHost: activeManagedHost() });
}

export function connectionViews(journalDir: string, base: NodeJS.ProcessEnv = process.env): Record<ConnectionKey, ConnectionView> {
  const stored = readSecrets(journalDir);
  const managed = toolsEnv({}, { dir: toolsDir(base), managedOllamaHost: activeManagedHost() });
  const out = {} as Record<ConnectionKey, ConnectionView>;
  for (const key of CONNECTION_KEYS) {
    const fromJournal = stored[key];
    const fromEnv = base[key];
    const value = fromJournal ?? fromEnv;
    if (!value) {
      const fromManaged = managed[key];
      out[key] = fromManaged ? { set: true, hint: fromManaged, source: 'managed' } : { set: false, hint: '' };
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
