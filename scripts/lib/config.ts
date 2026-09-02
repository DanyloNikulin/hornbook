import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournalConfig, languageName, type JournalConfigT } from '../../src/lib/journal-config.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let cached: JournalConfigT | null = null;

export function repoRootDir(): string {
  return repoRoot;
}

export function loadJournalConfig(): JournalConfigT {
  if (cached) return cached;
  const path = join(repoRoot, 'journal.config.json');
  if (!existsSync(path)) {
    throw new Error(`Missing journal.config.json at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = JournalConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid journal.config.json:\n${JSON.stringify(parsed.error.format(), null, 2)}`);
  }
  cached = parsed.data;
  return cached;
}

export function targetLanguageName(): string {
  return languageName(loadJournalConfig().pair.target);
}

export function learnerLanguageName(): string {
  return languageName(loadJournalConfig().pair.learner);
}
