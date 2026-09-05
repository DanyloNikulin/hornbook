import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export interface FileChange {
  path: string;
  data: string | Uint8Array | null;
}
export interface CommitStep {
  phase: 'stage' | 'apply' | 'restore';
  path: string;
  index: number;
}
export type CommitObserver = (step: CommitStep) => void;
const TRANSACTION = '_transaction';
const LOCK = '_write.lock';
const RECLAIM = '_write.reclaim';
const Manifest = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), existed: z.boolean(), write: z.boolean() })),
  directories: z.array(z.string()),
});

export class JournalBusyError extends Error {}

/** Every component is checked again during commit and recovery, including absent targets. */
export function checkedJournalPath(root: string, path: string): string {
  const parts = path.split('/');
  if (
    parts.some((p) => !/^[a-zA-Z0-9_.-]+$/.test(p) || p === '.' || p === '..') ||
    [TRANSACTION, LOCK, RECLAIM].some((name) => parts[0].toLowerCase() === name)
  )
    throw new Error('Unsafe journal transaction path');
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Journal path is a symbolic link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

function controlPath(root: string, name: string): string {
  const path = join(root, name);
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error('Journal control path is a symbolic link');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}

function flushDirectory(path: string): void {
  // Windows does not expose directory fsync through Node; file contents are still flushed.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicReplace(path: string, data: string | Uint8Array): void {
  const temp = join(dirname(path), `_pending-${randomUUID()}`);
  try {
    writeFileSync(temp, data, { flag: 'wx', flush: true });
    renameSync(temp, path);
    flushDirectory(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}

function lock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const path = controlPath(root, LOCK);
  if (existsSync(path)) {
    const reclaim = controlPath(root, RECLAIM);
    try {
      mkdirSync(reclaim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new JournalBusyError(
          'Journal recovery is busy; inspect _write.reclaim if its owner was interrupted',
        );
      throw error;
    }
    try {
      if (existsSync(path)) {
        let owner: { pid: number };
        try {
          owner = z
            .object({ pid: z.number().int().positive() })
            .parse(JSON.parse(readFileSync(path, 'utf8')));
        } catch {
          throw new JournalBusyError(
            'Unrecognized journal lock; inspect _write.lock before recovering',
          );
        }
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive)
          throw new JournalBusyError('Journal is busy; retry after the current write finishes');
        rmSync(path);
      }
    } finally {
      rmdirSync(reclaim);
    }
  }
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new JournalBusyError('Journal is busy');
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
  return () => rmSync(path, { force: true });
}

function recover(root: string, observer?: CommitObserver): void {
  const dir = controlPath(root, TRANSACTION);
  if (!existsSync(dir)) return;
  const manifestPath = controlPath(dir, 'manifest.json');
  if (existsSync(manifestPath) && !existsSync(controlPath(dir, 'committed'))) {
    const manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    // Validate the complete recovery plan before restoring the first file.
    for (const file of manifest.files) checkedJournalPath(root, file.path);
    for (const path of manifest.directories) checkedJournalPath(root, path);
    manifest.files.forEach((file, i) => {
      if (file.existed && !lstatSync(controlPath(dir, `before-${i}`)).isFile())
        throw new Error('Invalid recovery backup');
    });
    for (let i = manifest.files.length - 1; i >= 0; i--) {
      const file = manifest.files[i];
      observer?.({ phase: 'restore', path: file.path, index: i });
      const path = checkedJournalPath(root, file.path);
      if (file.existed) atomicReplace(path, readFileSync(controlPath(dir, `before-${i}`)));
      else rmSync(path, { force: true });
    }
    for (const path of [...manifest.directories].reverse()) {
      const directory = checkedJournalPath(root, path);
      if (existsSync(directory)) rmdirSync(directory);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  flushDirectory(root);
}

export function recoverJournal(root: string): boolean {
  if (!existsSync(controlPath(root, LOCK)) && !existsSync(controlPath(root, TRANSACTION)))
    return false;
  const release = lock(root);
  try {
    recover(root);
  } finally {
    release();
  }
  return true;
}

/** Plan under one writer lock, stage everything, then commit or restore the entire previous state. */
export function commitFiles<T>(
  root: string,
  plan: () => { changes: readonly FileChange[]; result: T },
  observer?: CommitObserver,
): T {
  const release = lock(root);
  let committed = false;
  try {
    recover(root);
    const { changes, result } = plan();
    if (changes.length === 0) return result;
    const paths = new Set<string>();
    const directories = new Set<string>();
    const files = changes.map((change) => {
      const path = checkedJournalPath(root, change.path);
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (paths.has(key)) throw new Error(`Duplicate transaction path: ${change.path}`);
      paths.add(key);
      if (existsSync(path) && !lstatSync(path).isFile())
        throw new Error(`Not a file: ${change.path}`);
      const parts = change.path.split('/');
      for (let n = 1; n < parts.length; n++) {
        const parent = parts.slice(0, n).join('/');
        if (!existsSync(checkedJournalPath(root, parent))) directories.add(parent);
      }
      return { path: change.path, existed: existsSync(path), write: change.data !== null };
    });
    const dir = controlPath(root, TRANSACTION);
    mkdirSync(dir);
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      observer?.({ phase: 'stage', path: change.path, index: i });
      if (files[i].existed)
        writeFileSync(
          join(dir, `before-${i}`),
          readFileSync(checkedJournalPath(root, change.path)),
          { flush: true },
        );
      if (change.data !== null)
        writeFileSync(join(dir, `after-${i}`), change.data, { flush: true });
    }
    atomicReplace(
      join(dir, 'manifest.json'),
      JSON.stringify({ version: 1, files, directories: [...directories] }),
    );
    flushDirectory(root);
    for (const path of directories) mkdirSync(checkedJournalPath(root, path), { recursive: true });
    for (let i = 0; i < changes.length; i++) {
      const file = files[i];
      observer?.({ phase: 'apply', path: file.path, index: i });
      const path = checkedJournalPath(root, file.path);
      if (file.write) renameSync(join(dir, `after-${i}`), path);
      else rmSync(path, { force: true });
      flushDirectory(dirname(path));
    }
    atomicReplace(join(dir, 'committed'), '1');
    committed = true;
    // Cleanup after the commit point cannot turn a successful write into a reported failure.
    try {
      recover(root);
    } catch {
      /* The next access retries cleanup. */
    }
    return result;
  } catch (error) {
    if (!committed) {
      try {
        recover(root, observer);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          'Write failed; recovery is pending. Reopen the journal to retry.',
          { cause: recoveryError },
        );
      }
    }
    throw error;
  } finally {
    release();
  }
}
