import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderStore } from './store.ts';
import { JournalRepository } from '../scripts/lib/journal.ts';
import { readCheatsheetBuild, publishCheatsheet } from '../scripts/lib/cheatsheet-storage.ts';
import { readSecrets, updateSecrets } from './secrets.ts';
import { buildSectionArchive } from './transfers.ts';
import { EMPTY_PROGRESS, Lesson, type ProgressT } from '../src/lib/schema.ts';
import { type CommitStep, type FileChange } from '../scripts/lib/file-commit.ts';

let root: string;
let store: FolderStore;
const lesson = (slug = 'audit') => Lesson.parse({ id: `2099-01-01-${slug}`, slug, date: '2099-01-01', title: 'Audit', summary: 'Synthetic', article_md: 'Original note' });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-repairs-'));
  store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('rechecks creation under the writer lock after another writer wins', () => {
  const original = JournalRepository.prototype.commit;
  const spy = vi.spyOn(JournalRepository.prototype, 'commit').mockImplementation(function<T>(this: JournalRepository, plan: () => { changes: readonly FileChange[]; result: T }): T {
    spy.mockRestore();
    new FolderStore(root).saveLesson('es-en', lesson());
    return original.call(this, plan) as T;
  });
  expect(() => store.saveLesson('es-en', { ...lesson(), article_md: 'Unrelated note' })).toThrow('already used');
  expect(store.lesson('es-en', 'audit').article_md).toBe('Original note');
});

it.each(['stage', 'apply'] as const)('preserves sheet bytes through %s failure and retry', (phase) => {
  const path = join(root, 'es-en', '_cheatsheet.json');
  const before = JSON.stringify({ processed_lessons: ['retained'], categories: [] });
  writeFileSync(path, before);
  const fail = (step: CommitStep) => { if (step.phase === phase) throw new Error('injected sheet failure'); };
  const journal = new JournalRepository(root, fail);
  const source = readCheatsheetBuild(journal, 'es-en');
  expect(() => publishCheatsheet(journal, 'es-en', source.revision, { processed_lessons: [], categories: [] })).toThrow('injected sheet failure');
  expect(readFileSync(path, 'utf8')).toBe(before);
  const reopened = new JournalRepository(root);
  publishCheatsheet(reopened, 'es-en', readCheatsheetBuild(reopened, 'es-en').revision, source.sheet);
  expect(readCheatsheetBuild(reopened, 'es-en').sheet.processed_lessons).toEqual(['retained']);
});

it.each(['sheet', 'lesson', 'catalog'] as const)('rejects stale sheet generation after competing %s change', (kind) => {
  const journal = new JournalRepository(root);
  const source = readCheatsheetBuild(journal, 'es-en');
  if (kind === 'sheet') publishCheatsheet(journal, 'es-en', source.revision, { processed_lessons: ['other'], categories: [] });
  if (kind === 'lesson') store.saveLesson('es-en', lesson());
  if (kind === 'catalog') journal.writeTopicCatalog('es-en', { ...source.catalog, categories: [] });
  expect(() => publishCheatsheet(journal, 'es-en', source.revision, source.sheet)).toThrow('sources changed');
});

it.each(['{broken', '{"categories":"bad"}'])('preserves malformed sheet input even before a force build: %s', (raw) => {
  const path = join(root, 'es-en', '_cheatsheet.json');
  writeFileSync(path, raw);
  expect(() => readCheatsheetBuild(new JournalRepository(root), 'es-en')).toThrow('preserved');
  expect(readFileSync(path, 'utf8')).toBe(raw);
});

it.each(['stage', 'apply'] as const)('rolls back combined provider and connection updates at every %s step', (phase) => {
  updateSecrets(root, { OPENAI_API_KEY: 'synthetic-connection-a', ANTHROPIC_API_KEY: 'synthetic-connection-b' });
  const config = readFileSync(join(root, 'journal.config.json'));
  const secrets = readFileSync(join(root, 'secrets.json'));
  for (let index = 0; index < 2; index++) {
    const failing = new FolderStore(root, (step) => { if (step.phase === phase && step.index === index) throw new Error('injected settings failure'); });
    expect(() => failing.updateSettings({ providers: { ...store.config().providers, extract: { driver: 'ollama', model: 'changed' } }, connections: { OLLAMA_HOST: 'http://localhost:11434' } })).toThrow('injected settings failure');
    expect(readFileSync(join(root, 'journal.config.json')).equals(config)).toBe(true);
    expect(readFileSync(join(root, 'secrets.json')).equals(secrets)).toBe(true);
  }
  new FolderStore(root).updateSettings({ connections: { OLLAMA_HOST: 'http://localhost:11434' } });
  expect(Object.keys(readSecrets(root)).sort()).toEqual(['ANTHROPIC_API_KEY', 'OLLAMA_HOST', 'OPENAI_API_KEY']);
});

it.each(['{broken', '[]', '{"OPENAI_API_KEY":42}'])('refuses to replace unreadable connections: %s', (raw) => {
  const path = join(root, 'secrets.json');
  writeFileSync(path, raw);
  expect(() => store.updateSettings({ connections: { OLLAMA_HOST: 'http://localhost:11434' } })).toThrow('preserved');
  expect(readFileSync(path, 'utf8')).toBe(raw);
});

it.each([false, true])('reserves incoming and destination orphan history regardless of order (reverse=%s)', (reverse) => {
  store.saveLesson('es-en', lesson());
  const incoming = structuredClone(EMPTY_PROGRESS);
  const state = (repetitions: number) => ({ repetitions, interval: 1, ef: 2.5, due: '2099-01-02' });
  const entries: [string, ReturnType<typeof state>][] = [['2099-01-01-audit:card:001', state(4)], ['2099-01-01-audit-2:card:001', state(9)]];
  incoming.sm2 = Object.fromEntries(reverse ? entries.reverse() : entries);
  const quizEntries: [string, ProgressT['quiz'][string]][] = [['audit', { attempts: 4, best_score: 1, total: 1, last_at: '2099-01-01' }], ['audit-2', { attempts: 9, best_score: 1, total: 1, last_at: '2099-01-01' }]];
  incoming.quiz = Object.fromEntries(reverse ? quizEntries.reverse() : quizEntries);
  const current = structuredClone(EMPTY_PROGRESS);
  current.quiz['audit-3'] = quizEntries[0][1];
  writeFileSync(join(root, 'es-en', '_progress.json'), JSON.stringify(current));
  const archive = buildSectionArchive({ section: store.section('es-en'), lessons: [lesson()], progress: incoming });
  store.importSection({ base64: archive.toString('base64'), conflict: 'keep-both' });
  const saved = JSON.parse(readFileSync(join(root, 'es-en', '_progress.json'), 'utf8')) as ProgressT;
  expect(saved.sm2['2099-01-01-audit-4:card:001'].repetitions).toBe(4);
  expect(saved.sm2['2099-01-01-audit-2:card:001'].repetitions).toBe(9);
  expect(Object.keys(saved.quiz).sort()).toEqual(['audit-2', 'audit-3', 'audit-4']);
  expect(existsSync(join(root, 'es-en', '2099-01-01-audit-4.json'))).toBe(true);
});
