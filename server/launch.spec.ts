import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countLessons, openCommand, seedJournal } from './launch.ts';

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
  writeFileSync(join(src, 'journal.config.json'), '{"sections":[]}');
  writeFileSync(join(src, 'secrets.json'), '{"OPENAI_API_KEY":"x"}');
  writeFileSync(join(src, 'es-en', '2026-01-01-a.json'), '{}');
  writeFileSync(join(src, 'es-en', '_cheatsheet.json'), '{}');
  writeFileSync(join(src, 'es-en', '_progress.json'), '{}');
  writeFileSync(join(src, 'es-en', '_derived', 'meta.json'), '[]');
  return src;
}

describe('seedJournal', () => {
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
    writeFileSync(join(dst, 'journal.config.json'), '{"mine":true}');
    expect(seedJournal(demo(), dst)).toBe(false);
    expect(existsSync(join(dst, 'es-en'))).toBe(false);
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
