import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderStore } from './store.ts';
import { buildSectionArchive } from './transfers.ts';
import { Lesson, EMPTY_PROGRESS, DEFAULT_TOPIC_CATALOG } from '../src/lib/schema.ts';
import type { CommitStep } from '../scripts/lib/file-commit.ts';

let root: string;
let store: FolderStore;
const lesson = (slug: string, date = '2026-01-01', related: string[] = []) =>
  Lesson.parse({
    id: `${date}-${slug}`,
    date,
    slug,
    title: slug,
    summary: 'Fixture',
    article_md: 'Fixture',
    related,
    vocabulary: [{ target: slug, learner: `meaning ${slug}` }],
  });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-import-safe-'));
  store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('import preservation', () => {
  it.each([false, true])(
    'requires explicit progress recovery before import (quarantined=%s)',
    (quarantined) => {
      const path = join(root, 'es-en/_progress.json');
      writeFileSync(path, '{broken');
      if (quarantined) store.progressView('es-en');
      const before = snapshot(root);
      const archive = buildSectionArchive({
        section: { id: 'es-en', target: 'es', learner: 'en' },
        lessons: [lesson('new')],
        progress: EMPTY_PROGRESS,
      });
      const input = { base64: archive.toString('base64'), conflict: 'error' };
      expect(() => store.importSection(input)).toThrow(expect.objectContaining({ status: 409 }));
      expect(snapshot(root)).toEqual(before);
      const recovery = store.progressView('es-en');
      store.saveProgress('es-en', EMPTY_PROGRESS, recovery.revision, true);
      store.importSection(input);
      expect(store.lesson('es-en', 'new').slug).toBe('new');
      expect(existsSync(join(root, 'es-en/_progress-recovery.json'))).toBe(false);
      expect(readFileSync(join(root, 'es-en', recovery.recovery!), 'utf8')).toBe('{broken');
    },
  );
  function snapshot(dir: string, base = ''): Record<string, string> {
    return Object.assign(
      {},
      ...readdirSync(dir, { withFileTypes: true }).map((entry) => {
        const name = base + entry.name;
        return entry.isDirectory()
          ? snapshot(join(dir, entry.name), name + '/')
          : { [name]: readFileSync(join(dir, entry.name)).toString('base64') };
      }),
    );
  }

  it.each([
    'es-en/2026-02-01-a.json',
    'es-en/2026-02-01-b.json',
    'es-en/_derived/cards.json',
    'es-en/_progress.json',
  ])('restores the complete section when committing %s fails', (path) => {
    let armed = false;
    store = new FolderStore(root, (step) => {
      if (armed && step.phase === 'apply' && step.path === path) throw new Error('injected');
    });
    store.saveLesson('es-en', lesson('a'));
    store.saveProgress('es-en', EMPTY_PROGRESS);
    const before = snapshot(root);
    const archive = buildSectionArchive({
      section: { id: 'es-en', target: 'es', learner: 'en' },
      lessons: [lesson('a', '2026-02-01'), lesson('b', '2026-02-01')],
      progress: EMPTY_PROGRESS,
    });
    armed = true;
    expect(() =>
      store.importSection({ base64: archive.toString('base64'), conflict: 'replace' }),
    ).toThrow('injected');
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    'it-en/_topics.json',
    'it-en/_backdrop.png',
    'journal.config.json',
    'it-en/_progress.json',
  ])('rolls back a new section when %s fails', (path) => {
    let armed = false;
    const observe = (step: CommitStep) => {
      if (armed && step.phase === 'apply' && step.path === path) throw new Error('injected');
    };
    store = new FolderStore(root, observe);
    const before = snapshot(root);
    const archive = buildSectionArchive({
      section: { id: 'it-en', target: 'it', learner: 'en' },
      lessons: [lesson('a')],
      topics: DEFAULT_TOPIC_CATALOG,
      backdrop: { name: '_backdrop.png', data: new Uint8Array([1, 2]) },
      progress: EMPTY_PROGRESS,
    });
    armed = true;
    expect(() =>
      store.importSection({ base64: archive.toString('base64'), conflict: 'error' }),
    ).toThrow('injected');
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, 'it-en'))).toBe(false);
  });
  it('keeps the original lesson when the replacement destination cannot be written', () => {
    store.saveLesson('es-en', lesson('a'));
    const path = join(root, 'es-en', '2026-01-01-a.json');
    const before = readFileSync(path);
    mkdirSync(join(root, 'es-en', '2026-02-01-a.json'));
    expect(() =>
      store.importLesson('es-en', { lesson: lesson('a', '2026-02-01'), conflict: 'replace' }),
    ).toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([false, true])(
    'maps colliding lessons, related links and progress once (reverse=%s)',
    (reverse) => {
      const previous = lesson('a');
      previous.vocabulary[0].target = 'previous';
      store.saveLesson('es-en', previous);
      const incoming = [lesson('a', '2026-01-01', ['a-2']), lesson('a-2', '2026-01-01', ['a'])];
      if (reverse) incoming.reverse();
      const first = { interval: 1, ef: 2.5, repetitions: 1, due: '2026-02-01' };
      const second = { interval: 6, ef: 2.7, repetitions: 2, due: '2026-02-06' };
      const archive = buildSectionArchive({
        section: { id: 'es-en', target: 'es', learner: 'en' },
        lessons: incoming,
        progress: {
          sm2: {
            '2026-01-01-a:vocab:001:target-learner': first,
            '2026-01-01-a-2:vocab:001:target-learner': second,
          },
          daily: null,
          activity: {},
          quiz: {
            a: { best_score: 1, total: 3, attempts: 1, last_at: '2026-01-01T00:00:00Z' },
            'a-2': { best_score: 2, total: 3, attempts: 2, last_at: '2026-01-02T00:00:00Z' },
          },
        },
      });
      store.importSection({ base64: archive.toString('base64'), conflict: 'keep-both' });
      // Reserve incoming original names before allocating suffixes, independent of input order.
      expect(store.lesson('es-en', 'a-3').related).toEqual(['a-2']);
      expect(store.lesson('es-en', 'a-2').related).toEqual(['a-3']);
      const progress = JSON.parse(readFileSync(join(root, 'es-en', '_progress.json'), 'utf8'));
      expect(progress.sm2['2026-01-01-a-3:vocab:001:target-learner']).toEqual(first);
      expect(progress.sm2['2026-01-01-a-2:vocab:001:target-learner']).toEqual(second);
      expect(progress.quiz['a-3'].best_score).toBe(1);
      expect(progress.quiz['a-2'].best_score).toBe(2);
      expect(store.progress('es-en').sm2).toEqual(progress.sm2);
    },
  );
});
