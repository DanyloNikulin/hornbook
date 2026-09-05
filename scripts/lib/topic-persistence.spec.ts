import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JournalRepository } from './journal.ts';

const fault = vi.hoisted(() => ({ armed: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.armed && typeof args[1] === 'string' && args[1].includes('failure-marker')) {
        fs.writeFileSync(args[0], args[1].slice(0, 8), args[2]);
        throw new Error('Injected disk full after partial write');
      }
      return fs.writeFileSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.armed = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('preserves the previous catalogue after a partial write, then permits a successful retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'hornbook-topics-'));
  roots.push(root);
  const journal = new JournalRepository(root);
  journal.saveJournalConfig({
    brand: { name: 'Test', tagline: 'Test' },
    providers: { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'ollama', model: 'test' } },
    sections: [],
  });
  journal.createSection({ target: 'es', learner: 'en' });
  const original = { categories: [], topics: [{ id: 'existing', categories: [], patterns: ['existing'] }] };
  journal.writeTopicCatalog('es-en', original);
  const path = journal.topicsPath('es-en');
  const before = readFileSync(path);
  const next = { ...original, topics: [...original.topics, { id: 'failure-marker', categories: [], patterns: ['new'] }] };
  fault.armed = true;
  expect(() => journal.writeTopicCatalog('es-en', next)).toThrow('Injected disk full');
  expect(readFileSync(path)).toEqual(before);
  expect(new JournalRepository(root).readTopicCatalog('es-en')).toEqual(original);
  expect(existsSync(join(root, '_transaction'))).toBe(false);
  fault.armed = false;
  journal.writeTopicCatalog('es-en', next);
  expect(new JournalRepository(root).readTopicCatalog('es-en')).toEqual(next);
});
