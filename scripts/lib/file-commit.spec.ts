import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commitFiles, recoverJournal, type FileChange } from './file-commit.ts';

let root: string;
const changes: FileChange[] = [
  { path: 'es-en/old.json', data: null },
  { path: 'es-en/new.json', data: 'new lesson' },
  { path: 'es-en/_derived/cards.json', data: 'new cards' },
  { path: 'es-en/_progress.json', data: 'new progress' },
  { path: 'journal.config.json', data: 'new config' },
];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-commit-'));
  mkdirSync(join(root, 'es-en'));
  writeFileSync(join(root, 'es-en/old.json'), 'old lesson');
  writeFileSync(join(root, 'es-en/_progress.json'), 'old progress');
  writeFileSync(join(root, 'journal.config.json'), 'old config');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function expectOriginal(): void {
  expect(readFileSync(join(root, 'es-en/old.json'), 'utf8')).toBe('old lesson');
  expect(readFileSync(join(root, 'es-en/_progress.json'), 'utf8')).toBe('old progress');
  expect(readFileSync(join(root, 'journal.config.json'), 'utf8')).toBe('old config');
  expect(existsSync(join(root, 'es-en/new.json'))).toBe(false);
  expect(existsSync(join(root, 'es-en/_derived'))).toBe(false);
  expect(existsSync(join(root, '_transaction'))).toBe(false);
}
describe('recoverable file commits', () => {
  it.each(['stage', 'apply'] as const)('restores every original after each %s failure', (phase) => {
    for (let index = 0; index < changes.length; index++) {
      expect(() =>
        commitFiles(
          root,
          () => ({ changes, result: 1 }),
          (step) => {
            if (step.phase === phase && step.index === index) throw new Error('injected');
          },
        ),
      ).toThrow('injected');
      expectOriginal();
    }
  });
  it('retries an interrupted rollback before exposing the journal', () => {
    expect(() =>
      commitFiles(
        root,
        () => ({ changes, result: 1 }),
        (step) => {
          if (
            (step.phase === 'apply' && step.index === 4) ||
            (step.phase === 'restore' && step.index === 1)
          )
            throw new Error('injected');
        },
      ),
    ).toThrow('recovery is pending');
    expect(existsSync(join(root, '_transaction'))).toBe(true);
    recoverJournal(root);
    expectOriginal();
  });
  it('recovers after the writer process exits midway through commit', () => {
    const child = join(root, 'crash.mjs');
    const module = pathToFileURL(resolve('scripts/lib/file-commit.ts')).href;
    writeFileSync(
      child,
      `import {commitFiles} from ${JSON.stringify(module)}; commitFiles(${JSON.stringify(root)}, () => ({changes:${JSON.stringify(changes)},result:1}), s => { if(s.phase==='apply' && s.index===4) process.exit(73); });`,
    );
    const result = spawnSync(process.execPath, ['--import', 'tsx', child], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(73);
    recoverJournal(root);
    expectOriginal();
  });
  it('does not read through an active writer lock', () => {
    commitFiles(root, () => {
      expect(() => recoverJournal(root)).toThrow('busy');
      return { changes, result: 1 };
    });
    expect(readFileSync(join(root, 'es-en/new.json'), 'utf8')).toBe('new lesson');
  });
  it.each(['../outside', '_transaction/before-0', '_WRITE.LOCK', 'es-en/../../outside'])(
    'rejects unsafe destination %s before mutation',
    (path) => {
      expect(() =>
        commitFiles(root, () => ({ changes: [...changes, { path, data: 'unsafe' }], result: 1 })),
      ).toThrow();
      expectOriginal();
    },
  );
});
