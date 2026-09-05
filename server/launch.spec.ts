import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countLessons, openCommand, seedJournal } from './launch.ts';
import { DEMO_JOURNAL } from '../scripts/lib/demo-journal.ts';

const config = JSON.stringify({ brand: { name: 'Test', tagline: 'Synthetic' }, providers: { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'ollama', model: 'test' } }, sections: [] });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-launch-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function demo(): string {
  const src = join(root, 'demo');
  mkdirSync(join(src, 'es-en', '_derived'), { recursive: true });
  mkdirSync(join(src, '_uploads'), { recursive: true });
  writeFileSync(join(src, 'journal.config.json'), config);
  writeFileSync(join(src, 'secrets.json'), '{"OPENAI_API_KEY":"x"}');
  writeFileSync(join(src, 'es-en', '2026-01-01-a.json'), '{}');
  writeFileSync(join(src, 'es-en', '_cheatsheet.json'), '{}');
  writeFileSync(join(src, 'es-en', '_progress.json'), '{}');
  writeFileSync(join(src, 'es-en', '_derived', 'meta.json'), '[]');
  return src;
}

describe('seedJournal', () => {
  it('diagnoses a legacy config-only seed without changing its files and can seed a separate recovery folder', () => {
    const dst = join(root, 'legacy');
    mkdirSync(dst);
    const original = DEMO_JOURNAL.find((file) => file.path === 'journal.config.json')!.data as string;
    writeFileSync(join(dst, 'journal.config.json'), original);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(seedJournal(DEMO_JOURNAL, dst)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEW empty journal folder'));
      expect(readdirSync(dst)).toEqual(['journal.config.json']);
      expect(readFileSync(join(dst, 'journal.config.json'), 'utf8')).toBe(original);
      const recovered = join(root, 'recovered');
      expect(seedJournal(DEMO_JOURNAL, recovered)).toBe(true);
      expect(countLessons(recovered)).toBe(3);
    } finally { warn.mockRestore(); }
  });
  it('copies the demo journal without per-machine files', () => {
    const dst = join(root, 'mine');
    expect(seedJournal(demo(), dst)).toBe(true);
    expect(existsSync(join(dst, 'journal.config.json'))).toBe(true);
    expect(existsSync(join(dst, 'es-en', '2026-01-01-a.json'))).toBe(true);
    expect(existsSync(join(dst, 'es-en', '_cheatsheet.json'))).toBe(true);
    expect(existsSync(join(dst, 'es-en', '_progress.json'))).toBe(false);
    expect(existsSync(join(dst, 'es-en', '_derived'))).toBe(false);
    expect(existsSync(join(dst, 'secrets.json'))).toBe(false);
    expect(existsSync(join(dst, '_uploads'))).toBe(false);
    expect(countLessons(dst)).toBe(1);
  });

  it('never touches an existing journal', () => {
    const dst = join(root, 'mine');
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'journal.config.json'), config);
    expect(seedJournal(demo(), dst)).toBe(false);
    expect(existsSync(join(dst, 'es-en'))).toBe(false);
  });

  it.each(['es-en/2026-01-01-greetings.json', 'unrelated.txt'])('preserves a nonempty folder containing %s', (name) => {
    const dst = join(root, 'mine');
    mkdirSync(join(dst, 'es-en'), { recursive: true });
    writeFileSync(join(dst, name), 'acknowledged user bytes');
    expect(() => seedJournal(DEMO_JOURNAL, dst)).toThrow('not empty');
    expect(readFileSync(join(dst, name), 'utf8')).toBe('acknowledged user bytes');
    expect(existsSync(join(dst, 'journal.config.json'))).toBe(false);
  });

  it('preserves corrupt configuration and reports it', () => {
    const dst = join(root, 'mine');
    mkdirSync(dst);
    writeFileSync(join(dst, 'journal.config.json'), '{broken');
    expect(() => seedJournal(DEMO_JOURNAL, dst)).toThrow();
    expect(readFileSync(join(dst, 'journal.config.json'), 'utf8')).toBe('{broken');
  });

  it.each(['stage', 'apply'] as const)('rolls back failures at every %s step and supports retry', (phase) => {
    for (let index = 0; index < DEMO_JOURNAL.length; index++) {
      const dst = join(root, `mine-${index}`);
      expect(() => seedJournal(DEMO_JOURNAL, dst, (step) => {
        if (step.phase === phase && step.index === index) throw new Error('injected disk failure');
      })).toThrow('injected disk failure');
      expect(readdirSync(dst)).toEqual([]);
      expect(seedJournal(DEMO_JOURNAL, dst)).toBe(true);
      expect(countLessons(dst)).toBe(3);
      expect(seedJournal(DEMO_JOURNAL, dst)).toBe(false);
    }
  });
});

describe('openCommand', () => {
  it('uses a chromeless app window with its own profile when a Chromium browser exists', () => {
    const c = openCommand('http://127.0.0.1:8787/', { app: true, journalDir: '/j', platform: 'linux', chromium: '/usr/bin/chromium' });
    expect(c.app).toBe(true);
    expect(c.cmd).toBe('/usr/bin/chromium');
    expect(c.args[0]).toBe('--app=http://127.0.0.1:8787/');
    expect(c.args.some((a) => a.includes('.app-profile'))).toBe(true);
  });

  it('falls back to the platform opener', () => {
    expect(openCommand('u', { app: true, journalDir: '/j', platform: 'linux', chromium: null })).toEqual({ cmd: 'xdg-open', args: ['u'], app: false });
    expect(openCommand('u', { app: false, journalDir: '/j', platform: 'darwin', chromium: '/x' })).toEqual({ cmd: 'open', args: ['u'], app: false });
    expect(openCommand('u', { app: false, journalDir: '/j', platform: 'win32', chromium: null })).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', 'u'], app: false });
  });
});
