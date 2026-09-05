import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FolderStore } from '../../server/store.ts';
import { readSectionArchive } from '../../server/transfers.ts';
import { Lesson } from '../../src/lib/schema.ts';
import { JournalRepository } from './journal.ts';
import { finalizeLesson, readStoredLesson } from './lesson-storage.ts';
import { repairLessonIdentities } from './identity-repair.ts';
import { migrateLegacyJournal } from './legacy-migration.ts';

let root: string;
const input = () =>
  Lesson.parse({
    id: '2025-01-01-old',
    date: '2025-01-01',
    slug: 'old',
    title: 'Old title',
    summary: 'Fixture',
    article_md: 'Fixture',
    vocabulary: [{ target: 'hola', learner: 'hello' }],
    flashcards: [{ type: 'word', front: 'adios', back: 'bye' }],
  });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-identity-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('finalizes child identities after date and title overrides without mutating input', () => {
  const original = input();
  const final = finalizeLesson(original, {
    date: '2026-02-03',
    slug: 'new-title',
    title: 'New title',
  });
  expect(final.id).toBe('2026-02-03-new-title');
  expect(final.vocabulary[0].id).toBe(`${final.id}:vocab:001`);
  expect(final.flashcards[0].id).toBe(`${final.id}:card:001`);
  expect(original.id).toBe('2025-01-01-old');
});

it('the JSON pipeline writes the same identities to raw files, API, derived data and export', () => {
  const store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
  const source = join(root, 'input.json');
  writeFileSync(source, JSON.stringify(input()));
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('scripts/process.ts'),
      source,
      '--from',
      'json',
      '--section',
      'es-en',
      '--date',
      '2026-02-03',
      '--title',
      'New title',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HORNBOOK_JOURNAL: root, HORNBOOK_WORK: join(root, 'work') },
    },
  );
  expect(run.status, run.stderr).toBe(0);
  const raw = JSON.parse(readFileSync(join(root, 'es-en/2026-02-03-new-title.json'), 'utf8'));
  expect(raw.id).toBe('2026-02-03-new-title');
  expect(raw.vocabulary[0].id).toBe(`${raw.id}:vocab:001`);
  expect(raw.flashcards[0].id).toBe(`${raw.id}:card:001`);
  expect(store.lesson('es-en', 'new-title')).toEqual(raw);
  const cards = JSON.parse(readFileSync(join(root, 'es-en/_derived/cards.json'), 'utf8'));
  expect(cards.some((card: { id: string }) => card.id.startsWith(raw.vocabulary[0].id))).toBe(true);
  const exported = store.exportSection('es-en', true);
  expect(readSectionArchive(exported.data).lessons[0]).toEqual(raw);
});

it('rejects inconsistent stored IDs and explicitly repairs lesson files and progress together', () => {
  const store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
  const old = { ...input(), date: '2026-02-03', slug: 'new-title' };
  const file = join(root, 'es-en/2025-01-01-old.json');
  writeFileSync(file, JSON.stringify(old));
  expect(() => readStoredLesson(old)).toThrow('inconsistent');
  const progress = {
    sm2: {
      [`${old.vocabulary[0].id}:target-learner`]: {
        interval: 1,
        ef: 2.5,
        repetitions: 1,
        due: '2026-02-03',
      },
    },
    quiz: {},
    activity: {},
    daily: null,
  };
  writeFileSync(join(root, 'es-en/_progress.json'), JSON.stringify(progress));
  expect(repairLessonIdentities(new JournalRepository(root), 'es-en')).toBe(1);
  expect(existsSync(file)).toBe(false);
  expect(store.lesson('es-en', 'new-title').id).toBe('2026-02-03-new-title');
  const repaired = JSON.parse(readFileSync(join(root, 'es-en/_progress.json'), 'utf8'));
  expect(Object.keys(repaired.sm2)).toEqual(['2026-02-03-new-title:vocab:001:target-learner']);
});

it('legacy migration leaves originals intact and retries after a failed config publication', () => {
  const source = join(root, 'legacy');
  const destination = join(root, 'new');
  mkdirSync(join(source, 'lessons'), { recursive: true });
  const bootstrap = new FolderStore(join(root, 'template'));
  bootstrap.createSection({ target: 'es', learner: 'en' });
  const config = readFileSync(join(root, 'template/journal.config.json'));
  writeFileSync(join(source, 'journal.config.json'), config);
  const original = JSON.stringify(input());
  writeFileSync(join(source, 'lessons/old.json'), original);
  expect(migrateLegacyJournal(source, destination, true).length).toBeGreaterThan(0);
  expect(existsSync(destination)).toBe(false);
  expect(() =>
    migrateLegacyJournal(source, destination, false, (step) => {
      if (step.phase === 'apply' && step.path === 'journal.config.json')
        throw new Error('injected');
    }),
  ).toThrow('injected');
  expect(existsSync(join(destination, 'journal.config.json'))).toBe(false);
  expect(readFileSync(join(source, 'lessons/old.json'), 'utf8')).toBe(original);
  migrateLegacyJournal(source, destination);
  expect(new FolderStore(destination).lesson('es-en', 'old')).toEqual(input());
  expect(readFileSync(join(source, 'journal.config.json'))).toEqual(config);
  expect(migrateLegacyJournal(source, destination)).toEqual([]);
});
