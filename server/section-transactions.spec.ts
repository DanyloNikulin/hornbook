import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderStore } from './store.ts';
import { JournalRepository } from '../scripts/lib/journal.ts';
import type { CommitStep, FileChange } from '../scripts/lib/file-commit.ts';

let root: string;
let store: FolderStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-section-transaction-'));
  store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function beforeNextLock(action: () => void): void {
  const original = JournalRepository.prototype.commit;
  const spy = vi.spyOn(JournalRepository.prototype, 'commit').mockImplementation(function<T>(this: JournalRepository, plan: () => { changes: readonly FileChange[]; result: T }): T {
    spy.mockRestore();
    action();
    return original.call(this, plan) as T;
  });
}

it.each(['section', 'settings'] as const)('preserves a competing section creation during %s update', (kind) => {
  beforeNextLock(() => new FolderStore(root).createSection({ target: 'it', learner: 'en' }));
  if (kind === 'section') store.updateSection('es-en', { title: 'New title' });
  else store.updateSettings({ providers: { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'ollama', model: 'new-model' } } });
  const config = new FolderStore(root).config();
  expect(config.sections.map((s) => s.id)).toEqual(['es-en', 'it-en']);
  if (kind === 'section') expect(config.sections[0].title).toBe('New title');
  else expect(config.providers.extract.model).toBe('new-model');
});

it('merges an unrelated provider change before updating the section title', () => {
  beforeNextLock(() => new FolderStore(root).updateSection('es-en', { providers: { extract: { driver: 'ollama', model: 'other' } } }));
  store.updateSection('es-en', { title: 'New title' });
  expect(new FolderStore(root).section('es-en')).toMatchObject({ title: 'New title', providers: { extract: { model: 'other' } } });
});

it('rechecks lesson membership under the deletion lock', () => {
  beforeNextLock(() => new FolderStore(root).saveLesson('es-en', { id: '2026-01-01-new', date: '2026-01-01', slug: 'new', title: 'New', summary: 'New', article_md: 'New' }));
  expect(() => store.deleteSection('es-en')).toThrow('still has lessons');
  expect(new FolderStore(root).lesson('es-en', 'new').title).toBe('New');
});

it('does not overwrite another writer when initializing a new journal', () => {
  const directory = join(root, 'new-journal');
  beforeNextLock(() => new FolderStore(directory).createSection({ target: 'it', learner: 'en' }));
  expect(new FolderStore(directory).config().sections.map((s) => s.id)).toEqual(['it-en']);
});

it('preserves an unrelated section created before deletion acquires its lock', () => {
  beforeNextLock(() => new FolderStore(root).createSection({ target: 'it', learner: 'en' }));
  store.deleteSection('es-en');
  expect(new FolderStore(root).config().sections.map((s) => s.id)).toEqual(['it-en']);
  expect(existsSync(join(root, 'es-en'))).toBe(false);
});

it.each(['png', 'jpg', null] as const)('commits backdrop bytes and reference together for %s', (extension) => {
  store.saveBackdrop('es-en', { filename: 'old.png', base64: Buffer.from('original-image').toString('base64') });
  if (extension === null) store.deleteBackdrop('es-en');
  else store.saveBackdrop('es-en', { filename: `new.${extension}`, base64: Buffer.from('new-image').toString('base64') });
  const reopened = new FolderStore(root);
  if (extension === null) {
    expect(reopened.section('es-en').theme?.backdrop).toBeUndefined();
    expect(reopened.backdropPath('es-en')).toBeNull();
  } else {
    expect(reopened.section('es-en').theme?.backdrop).toBe(`_backdrop.${extension}`);
    expect(readFileSync(reopened.backdropPath('es-en')!, 'utf8')).toBe('new-image');
  }
  expect(existsSync(join(root, 'es-en', '_backdrop.png'))).toBe(extension === 'png');
});

it.each(['png', 'jpg', null] as const)('rolls back each backdrop transaction step for %s', (extension) => {
  store.saveBackdrop('es-en', { filename: 'old.png', base64: Buffer.from('original-image').toString('base64') });
  const config = readFileSync(join(root, 'journal.config.json'));
  const paths = ['journal.config.json', 'es-en/_backdrop.png', ...(extension === 'jpg' ? ['es-en/_backdrop.jpg'] : [])];
  for (const phase of ['stage', 'apply'] as const) for (const path of paths) {
    let armed = false;
    const faulty = new FolderStore(root, (step: CommitStep) => { if (armed && step.phase === phase && step.path === path) throw new Error('injected'); });
    armed = true;
    const mutate = () => extension === null ? faulty.deleteBackdrop('es-en') : faulty.saveBackdrop('es-en', { filename: `new.${extension}`, base64: Buffer.from('new-image').toString('base64') });
    expect(mutate, `${phase} ${path}`).toThrow('injected');
    expect(readFileSync(join(root, 'es-en', '_backdrop.png'), 'utf8')).toBe('original-image');
    expect(readFileSync(join(root, 'journal.config.json'))).toEqual(config);
    expect(existsSync(join(root, 'es-en', '_backdrop.jpg'))).toBe(false);
    expect(new FolderStore(root).backdropPath('es-en')).toBe(join(root, 'es-en', '_backdrop.png'));
  }
});
