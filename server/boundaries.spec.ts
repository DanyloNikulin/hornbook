import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FolderStore } from './store.ts';

const roots: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hornbook-boundary-'));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('journal ownership and containment', () => {
  it('rejects a redirected derived directory before rebuilding files', () => {
    const root = fixture();
    const store = new FolderStore(join(root, 'journal'));
    store.createSection({ target: 'es', learner: 'en' });
    const derived = join(store.dir, 'es-en', '_derived');
    rmSync(derived, { recursive: true });
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'meta.json'), 'keep');
    symlinkSync(join(root, 'outside'), derived, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.lessonMetas('es-en')).toThrow();
    expect(readFileSync(join(root, 'outside', 'meta.json'), 'utf8')).toBe('keep');
  });
  it('keeps two stores independent across reads and mutations', () => {
    const a = new FolderStore(fixture());
    a.createSection({ target: 'es', learner: 'en' });
    const aDir = a.dir;
    const b = new FolderStore(fixture());
    b.createSection({ target: 'it', learner: 'en' });
    expect(a.dir).toBe(aDir);
    expect(a.config().sections.map((s) => s.id)).toEqual(['es-en']);
    a.saveBackdrop('es-en', { filename: 'test.png', base64: 'YWJj' });
    expect(b.config().sections.map((s) => s.id)).toEqual(['it-en']);
    expect(existsSync(join(b.dir, 'es-en'))).toBe(false);
  });

  it.each([
    '../outside',
    '..\\outside',
    '%2e%2e%2foutside',
    'unknown',
    'es-en/../outside',
    '/outside',
  ])('rejects %s before touching files', (id) => {
    const root = fixture();
    const store = new FolderStore(join(root, 'journal'));
    store.createSection({ target: 'es', learner: 'en' });
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', '_backdrop.jpg'), 'keep');
    expect(() => store.saveBackdrop(id, { filename: 'test.png', base64: 'YWJj' })).toThrow();
    expect(readFileSync(join(root, 'outside', '_backdrop.jpg'), 'utf8')).toBe('keep');
    expect(existsSync(join(root, 'outside', '_backdrop.png'))).toBe(false);
    expect(existsSync(join(store.dir, 'unknown'))).toBe(false);
  });

  it('rejects a section redirected through a junction or symlink', () => {
    const root = fixture();
    const store = new FolderStore(join(root, 'journal'));
    store.createSection({ target: 'es', learner: 'en' });
    rmSync(join(store.dir, 'es-en'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', '_backdrop.jpg'), 'keep');
    symlinkSync(
      join(root, 'outside'),
      join(store.dir, 'es-en'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => store.saveBackdrop('es-en', { filename: 'test.png', base64: 'YWJj' })).toThrow();
    expect(readFileSync(join(root, 'outside', '_backdrop.jpg'), 'utf8')).toBe('keep');
  });
});
