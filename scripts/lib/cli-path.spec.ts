import { describe, expect, it } from 'vitest';
import { resolveCli } from './cli-path.ts';

const only =
  (...files: string[]) =>
  (p: string) =>
    files.includes(p);

describe('resolveCli', () => {
  it('finds an .exe and an npm .cmd shim on a Windows PATH', () => {
    const env = { Path: 'C:\\npm;C:\\bin' };
    const exists = only('C:\\npm\\codex.cmd', 'C:\\bin\\claude.exe');
    expect(resolveCli('codex', env, { exists, platform: 'win32' })).toBe('C:\\npm\\codex.cmd');
    expect(resolveCli('claude', env, { exists, platform: 'win32' })).toBe('C:\\bin\\claude.exe');
    expect(resolveCli('grok', env, { exists, platform: 'win32' })).toBeUndefined();
  });

  it('honours PATHEXT and tries a name that already has an extension as is', () => {
    const env = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE' };
    const exists = only('C:\\bin\\kimi.EXE', 'C:\\bin\\claude.exe');
    expect(resolveCli('kimi', env, { exists, platform: 'win32' })).toBe('C:\\bin\\kimi.EXE');
    expect(resolveCli('claude.exe', env, { exists, platform: 'win32' })).toBe('C:\\bin\\claude.exe');
    expect(resolveCli('kimi.exe', env, { exists, platform: 'win32' })).toBeUndefined();
  });

  it('searches a POSIX PATH by bare name only', () => {
    const env = { PATH: '/usr/bin:/home/u/.local/bin' };
    const exists = only('/home/u/.local/bin/claude');
    expect(resolveCli('claude', env, { exists, platform: 'linux' })).toBe('/home/u/.local/bin/claude');
    expect(resolveCli('kimi', env, { exists, platform: 'linux' })).toBeUndefined();
  });

  it('takes an explicit path as given and fails when it is missing', () => {
    const env = { PATH: 'C:\\bin' };
    expect(resolveCli('C:\\tools\\claude.exe', env, { exists: () => true, platform: 'win32' })).toBe(
      'C:\\tools\\claude.exe',
    );
    expect(resolveCli('C:\\tools\\claude.exe', env, { exists: () => false, platform: 'win32' })).toBeUndefined();
    expect(resolveCli('./bin/grok', env, { exists: () => false, platform: 'linux' })).toBeUndefined();
  });

  it('finds nothing without a PATH', () => {
    expect(resolveCli('claude', {}, { exists: () => true, platform: 'win32' })).toBeUndefined();
  });
});
