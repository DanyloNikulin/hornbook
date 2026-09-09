import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderStore } from './store.ts';
import { buildSectionArchive } from './transfers.ts';
import { JournalRepository } from '../scripts/lib/journal.ts';
import { Lesson, EMPTY_PROGRESS } from '../src/lib/schema.ts';

let root: string;
let store: FolderStore;
const lesson = (slug: string, date = '2026-01-01', title = slug) => Lesson.parse({
  id: `${date}-${slug}`, slug, date, title, summary: 'Fixture', article_md: 'Fixture',
  vocabulary: [{ target: slug, learner: `meaning ${slug}` }],
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-recovery-safety-'));
  store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
  store.saveLesson('es-en', lesson('good'));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function trashEntries(): string[] {
  const dir = join(root, '_trash');
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}

it.each(['png', 'jpg', null] as const)('retains the previous backdrop when replaced with %s', (extension) => {
  store.saveBackdrop('es-en', { filename: 'old.png', base64: Buffer.from('original').toString('base64') });
  if (extension === null) store.deleteBackdrop('es-en');
  else store.saveBackdrop('es-en', { filename: `new.${extension}`, base64: Buffer.from('replacement').toString('base64') });
  const entries = trashEntries();
  expect(entries).toHaveLength(1);
  expect(readFileSync(join(entries[0], 'files/es-en/_backdrop.png'), 'utf8')).toBe('original');
  const restored = readFileSync(join(entries[0], 'files/es-en/_backdrop.png')).toString('base64');
  store.saveBackdrop('es-en', { filename: 'restored.png', base64: restored });
  expect(readFileSync(store.backdropPath('es-en')!, 'utf8')).toBe('original');
});

it('reuses healthy projections across list, vocabulary, cards and search reads', () => {
  const scan = vi.spyOn(JournalRepository.prototype, 'scanSectionLessons');
  store.lessonMetas('es-en');
  for (const kind of ['vocab', 'cards', 'search-index'] as const) store.derived('es-en', kind);
  store.lessonListing('es-en');
  expect(scan).toHaveBeenCalledTimes(1);
  // Another repository instance writes newer content; this store must see it.
  new FolderStore(root).saveLesson('es-en', lesson('good', '2026-01-01', 'Updated'), 'replace');
  expect(store.lessonMetas('es-en')[0].title).toBe('Updated');
});

it('invalidates cached content for a same-size external edit even when mtime is restored', () => {
  expect(store.lessonMetas('es-en')[0].title).toBe('good');
  const path = join(root, 'es-en/2026-01-01-good.json');
  const stat = statSync(path);
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace('"title": "good"', '"title": "fine"'));
  utimesSync(path, stat.atime, stat.mtime);
  expect(store.lessonMetas('es-en')[0].title).toBe('fine');
  writeFileSync(path, '{broken');
  expect(store.lessonListing('es-en').issues).toHaveLength(1);
  expect(store.lessonMetas('es-en')).toEqual([]);
  writeFileSync(path, original);
  expect(store.lessonMetas('es-en')[0].title).toBe('good');
  rmSync(path);
  expect(store.lessonMetas('es-en')).toEqual([]);
});

it.each(['delete', 'save', 'import-same-date', 'import-new-date', 'section-import'])(
  'retains exact original lesson and markdown bytes after %s and supports restoring the lesson', (action) => {
    const filename = '2026-01-01-good';
    const json = readFileSync(join(root, 'es-en', `${filename}.json`));
    const markdown = readFileSync(join(root, 'es-en', `${filename}.md`));
    if (action === 'delete') store.deleteLesson('es-en', 'good');
    else if (action === 'save') store.saveLesson('es-en', lesson('good', '2026-01-01', 'Updated'), 'replace');
    else if (action === 'section-import') {
      const archive = buildSectionArchive({ section: store.section('es-en'), lessons: [lesson('good', '2026-02-01')] });
      store.importSection({ base64: archive.toString('base64'), conflict: 'replace' });
    } else store.importLesson('es-en', {
      lesson: lesson('good', action === 'import-new-date' ? '2026-02-01' : '2026-01-01', 'Updated'),
      conflict: 'replace',
    });
    const entries = trashEntries();
    expect(entries).toHaveLength(1);
    expect(readFileSync(join(entries[0], 'files/es-en', `${filename}.json`))).toEqual(json);
    expect(readFileSync(join(entries[0], 'files/es-en', `${filename}.md`))).toEqual(markdown);
    expect(JSON.parse(readFileSync(join(entries[0], 'manifest.json'), 'utf8')).files).toContain(`es-en/${filename}.json`);
    new FolderStore(root).importLesson('es-en', { lesson: JSON.parse(json.toString()), conflict: 'replace' });
    expect(new FolderStore(root).lesson('es-en', 'good').title).toBe('good');
  },
);

it('keeps section configuration, progress and other files after deleting an empty section', () => {
  store.deleteLesson('es-en', 'good');
  store.saveProgress('es-en', EMPTY_PROGRESS);
  const config = readFileSync(join(root, 'journal.config.json'));
  const progress = readFileSync(join(root, 'es-en/_progress.json'));
  store.deleteSection('es-en');
  const entry = trashEntries().find((dir) => existsSync(join(dir, 'files/journal.config.json')))!;
  expect(readFileSync(join(entry, 'files/journal.config.json'))).toEqual(config);
  expect(readFileSync(join(entry, 'files/es-en/_progress.json'))).toEqual(progress);
  expect(existsSync(join(root, 'es-en'))).toBe(false);
  expect(store.config().sections).toEqual([]);
});

it.each(['stage', 'apply'] as const)('rolls back the deletion if retaining its backup fails during %s', (phase) => {
  const before = readFileSync(join(root, 'es-en/2026-01-01-good.json'));
  let armed = false;
  const faulty = new FolderStore(root, (step) => {
    if (armed && step.phase === phase && step.path.startsWith('_trash/')) throw new Error('backup failure');
  });
  armed = true;
  expect(() => faulty.deleteLesson('es-en', 'good')).toThrow('backup failure');
  expect(readFileSync(join(root, 'es-en/2026-01-01-good.json'))).toEqual(before);
  expect(new FolderStore(root).lessonMetas('es-en').map((meta) => meta.slug)).toEqual(['good']);
  expect(trashEntries()).toEqual([]);
});

it.each(['{broken', '{}', JSON.stringify({ ...lesson('bad'), id: 'wrong' })])(
  'keeps healthy lessons, vocabulary, cards and search available for damaged source %s', (raw) => {
    store.saveLesson('es-en', lesson('bad'));
    const file = join(root, 'es-en/2026-01-01-bad.json');
    const original = readFileSync(file);
    writeFileSync(file, raw);
    const listing = store.lessonListing('es-en');
    expect(listing.lessons.map((meta) => meta.slug)).toEqual(['good']);
    expect(listing.issues).toEqual([expect.objectContaining({ file: '2026-01-01-bad.json' })]);
    expect(store.lesson('es-en', 'good').title).toBe('good');
    expect(JSON.parse(store.derived('es-en', 'vocab')).map((entry: { target: string }) => entry.target)).toEqual(['good']);
    expect(store.derived('es-en', 'cards')).not.toContain('2026-01-01-bad');
    expect(store.derived('es-en', 'search-index')).not.toContain('"lesson_slug":"bad"');
    expect(() => store.saveLesson('es-en', lesson('new'))).toThrow('failed validation');
    expect(() => store.deleteLesson('es-en', 'good')).toThrow('failed validation');
    expect(() => store.exportSection('es-en', false)).toThrow('failed validation');
    expect(() => new JournalRepository(root).writeDerived('es-en')).toThrow('failed validation');
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(trashEntries()).toEqual([]);
    writeFileSync(file, original);
    expect(store.lessonListing('es-en').issues).toEqual([]);
    expect(store.lessonMetas('es-en')).toHaveLength(2);
  },
);

it('shows diagnostics when every lesson is damaged', () => {
  writeFileSync(join(root, 'es-en/2026-01-01-good.json'), '{broken');
  expect(store.lessonListing('es-en')).toMatchObject({ lessons: [], issues: [{ file: '2026-01-01-good.json' }] });
  expect(JSON.parse(store.derived('es-en', 'cards'))).toEqual([]);
});

it('reads progress with a damaged lesson and no derived cache without deleting its history', () => {
  const history = { interval: 1, ef: 2.5, repetitions: 1, due: '2026-02-01' };
  store.saveProgress('es-en', { ...EMPTY_PROGRESS, sm2: { 'unavailable-card': history } });
  writeFileSync(join(root, 'es-en/broken.json'), '{broken');
  const derived = join(root, 'es-en', '_derived');
  rmSync(derived, { recursive: true });
  expect(store.progressView('es-en').sm2['unavailable-card']).toEqual(history);
});
