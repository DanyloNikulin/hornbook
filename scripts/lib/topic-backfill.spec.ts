import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderStore } from '../../server/store.ts';
import { JournalRepository } from './journal.ts';
import { backfillSection } from './topic-backfill.ts';
import type { CommitStep } from './file-commit.ts';

let root: string;
let journal: JournalRepository;
let steps: CommitStep[];
let failPath: string | undefined;
function snapshot(dir = root): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry): [string, string][] => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? Object.entries(snapshot(path)).map(([name, bytes]) => [entry.name + '/' + name, bytes])
        : [[entry.name, readFileSync(path).toString('base64')]];
    }),
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-backfill-'));
  const store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
  for (let n = 1; n <= 3; n++)
    store.saveLesson('es-en', {
      id: `2026-09-05-test-${n}`,
      date: '2026-09-05',
      slug: `test-${n}`,
      title: 'Hello',
      summary: 'Hello',
      article_md: 'Hello',
      topics: n === 1 ? ['curated'] : [],
    });
  journal = new JournalRepository(root);
  journal.writeTopicCatalog('es-en', {
    categories: [],
    topics: [{ id: 'greeting', categories: [], patterns: ['Hello'] }],
  });
  steps = [];
  failPath = undefined;
  journal = new JournalRepository(root, (step) => {
    steps.push(step);
    if (step.phase === 'apply' && step.path === failPath) throw new Error('injected');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('reads once and writes a single derived bundle for every changed lesson', () => {
  const read = vi.spyOn(journal, 'readSectionLessons');
  const result = backfillSection(journal, 'es-en', { auto: true });
  expect(result.updates).toHaveLength(3);
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    steps.filter((step) => step.phase === 'apply' && step.path === 'es-en/_derived/cards.json'),
  ).toHaveLength(1);
  expect(journal.readSectionLessons('es-en')[0].lesson.topics).toEqual(['curated', 'greeting']);
  expect(existsSync(join(root, 'es-en/_topics-version.json'))).toBe(true);
  expect(
    JSON.parse(readFileSync(join(root, 'es-en/_derived/meta.json'), 'utf8')).every(
      (lesson: { topics: string[] }) => lesson.topics.includes('greeting'),
    ),
  ).toBe(true);
  steps.length = 0;
  expect(backfillSection(journal, 'es-en', { auto: true }).updates).toHaveLength(0);
  expect(steps).toHaveLength(0);
});

it.each([
  'es-en/2026-09-05-test-2.json',
  'es-en/_derived/cards.json',
  'es-en/_topics-version.json',
])('rolls back the entire batch and hash on failure at %s', (path) => {
  const before = snapshot();
  failPath = path;
  expect(() => backfillSection(journal, 'es-en', { auto: true })).toThrow('injected');
  expect(snapshot()).toEqual(before);
});

it('keeps dry-run read-only and preserves only-empty and rebuild modes', () => {
  const before = snapshot();
  expect(backfillSection(journal, 'es-en', { auto: true, dryRun: true }).updates).toHaveLength(3);
  expect(snapshot()).toEqual(before);
  expect(steps).toHaveLength(0);
  expect(backfillSection(journal, 'es-en', { onlyEmpty: true }).updates).toHaveLength(2);
  expect(journal.readSectionLessons('es-en')[0].lesson.topics).toEqual(['curated']);
  expect(backfillSection(journal, 'es-en', { rebuild: true }).updates).toHaveLength(1);
  expect(journal.readSectionLessons('es-en')[0].lesson.topics).toEqual(['greeting']);
});

it('refuses malformed source lessons before writing any part of a batch', () => {
  writeFileSync(join(root, 'es-en/2026-09-05-test-2.json'), '{broken');
  const before = snapshot();
  expect(() => backfillSection(journal, 'es-en', { auto: true })).toThrow('failed validation');
  expect(snapshot()).toEqual(before);
});
