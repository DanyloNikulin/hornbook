import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderStore } from './store.ts';
import { EMPTY_PROGRESS } from '../src/lib/schema.ts';
import { desktopProgressDraft } from '../electron/progress-drafts.ts';

let root: string;
let store: FolderStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-progress-'));
  store = new FolderStore(root);
  store.createSection({ target: 'es', learner: 'en' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('durable progress', () => {
  it('preserves invalid UTF-8 bytes in the quarantine backup', () => {
    const raw = Buffer.from([123, 255, 254, 0, 125]);
    writeFileSync(join(root, 'es-en/_progress.json'), raw);
    const view = store.progressView('es-en');
    expect(readFileSync(join(root, 'es-en', view.recovery!))).toEqual(raw);
  });
  it('rejects a stale client without changing the acknowledged document', () => {
    const first = store.progressView('es-en');
    const second = new FolderStore(root).progressView('es-en');
    const saved = store.saveProgress(
      'es-en',
      { ...first, activity: { '2026-09-04': 3 } },
      first.revision,
    );
    expect(() =>
      store.saveProgress('es-en', { ...second, activity: { '2026-09-04': 1 } }, second.revision),
    ).toThrow('changed elsewhere');
    expect(store.progressView('es-en')).toEqual(saved);
  });
  it.each(['{broken', '{"sm2":"wrong"}'])(
    'quarantines corrupt progress once and requires explicit recovery: %s',
    (raw) => {
      const path = join(root, 'es-en/_progress.json');
      writeFileSync(path, raw);
      const view = store.progressView('es-en');
      expect(view.recovery).toBeTruthy();
      expect(readFileSync(join(root, 'es-en', view.recovery!), 'utf8')).toBe(raw);
      expect(existsSync(path)).toBe(false);
      expect(store.progressView('es-en')).toEqual(view);
      expect(
        readdirSync(join(root, 'es-en')).filter((name) => name.startsWith('_progress.corrupt-')),
      ).toHaveLength(1);
      expect(() => store.saveProgress('es-en', EMPTY_PROGRESS, view.revision)).toThrow(
        'explicit recovery',
      );
      const saved = store.saveProgress('es-en', EMPTY_PROGRESS, view.revision, true);
      expect(saved.recovery).toBeUndefined();
      expect(store.progress('es-en')).toEqual(EMPTY_PROGRESS);
      expect(readFileSync(join(root, 'es-en', view.recovery!), 'utf8')).toBe(raw);
    },
  );
  it('restores the original bytes if quarantine fails midway', () => {
    const path = join(root, 'es-en/_progress.json');
    writeFileSync(path, '{broken');
    const failing = new FolderStore(root, (step) => {
      if (step.phase === 'apply' && step.path.endsWith('/_progress.json'))
        throw new Error('injected');
    });
    expect(() => failing.progressView('es-en')).toThrow('injected');
    expect(readFileSync(path, 'utf8')).toBe('{broken');
    expect(readdirSync(join(root, 'es-en')).filter((name) => name.startsWith('_progress'))).toEqual(
      ['_progress.json'],
    );
  });
  it('desktop drafts survive restart and remain separated by journal and section', () => {
    const directory = join(root, 'drafts');
    const value = {
      revision: 'r1',
      snapshot: { ...EMPTY_PROGRESS, activity: { '2026-09-04': 3 } },
    };
    expect(desktopProgressDraft(directory, root, 'es-en', value).error).toBeUndefined();
    expect(desktopProgressDraft(directory, root, 'es-en').value).toEqual(value);
    expect(desktopProgressDraft(directory, join(root, 'other'), 'es-en').value).toBeNull();
    expect(desktopProgressDraft(directory, root, 'it-en').value).toBeNull();
    expect(desktopProgressDraft(directory, root, '../outside', value).error).toBeTruthy();
    expect(desktopProgressDraft(directory, root, 'es-en', null).value).toBeNull();
  });
});
