import { describe, expect, it } from 'vitest';
import { updateCli } from './update-cli.ts';

const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };

describe('updateCli', () => {
  it('runs the CLI’s own updater from PATH and reports the version it has afterwards', async () => {
    const calls: string[][] = [];
    const result = await updateCli('kimi', {
      env,
      platform: 'win32',
      exists: (p) => p === 'C:\\bin\\kimi.EXE' || p === 'C:\\bin\\kimi.exe',
      run: async (bin, args, mode) => {
        calls.push([bin, ...args, mode]);
        return { code: 0, out: mode === 'capture' ? '0.41.0\n' : '' };
      },
    });
    expect(calls).toEqual([
      ['C:\\bin\\kimi.EXE', 'upgrade', 'inherit'],
      ['C:\\bin\\kimi.EXE', '--version', 'capture'],
    ]);
    expect(result).toEqual({ tool: 'kimi', path: 'C:\\bin\\kimi.EXE', version: '0.41.0' });
  });

  it('prefers the path set in Settings and fails clearly when the updater does', async () => {
    await expect(
      updateCli('codex', {
        env: { ...env, CODEX_BIN: 'D:\\tools\\codex.cmd' },
        platform: 'win32',
        exists: (p) => p === 'D:\\tools\\codex.cmd',
        run: async (bin, args) => ({ code: args[0] === 'update' ? 2 : 0, out: bin }),
      }),
    ).rejects.toThrow('Codex updater exited 2');
  });

  it('names the missing CLI instead of running anything', async () => {
    await expect(updateCli('grok', { env, platform: 'win32', exists: () => false, run: async () => { throw new Error('must not run'); } })).rejects.toThrow(
      'The grok CLI is not on PATH',
    );
  });
});
