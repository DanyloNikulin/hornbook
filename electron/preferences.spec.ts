import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPreferences, savePreferences } from './preferences.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('desktop preferences', () => {
  it('defaults updates on and startup off, then round-trips valid values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornbook-desktop-'));
    dirs.push(dir);
    const path = join(dir, 'preferences.json');
    expect(loadPreferences(path)).toEqual({ automaticUpdates: true, startWithSystem: false });
    savePreferences(path, { automaticUpdates: false, startWithSystem: true, journal: 'C:\\Lessons', window: { width: 1200, height: 800 } });
    expect(loadPreferences(path)).toMatchObject({ automaticUpdates: false, startWithSystem: true, journal: 'C:\\Lessons', window: { width: 1200, height: 800 } });
  });

  it('falls back safely for corrupt or implausible values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornbook-desktop-'));
    dirs.push(dir);
    const path = join(dir, 'preferences.json');
    writeFileSync(path, '{nope');
    expect(loadPreferences(path)).toEqual({ automaticUpdates: true, startWithSystem: false });
    writeFileSync(path, JSON.stringify({ window: { width: 1, height: 1 } }));
    expect(loadPreferences(path).window).toBeUndefined();
  });
});
