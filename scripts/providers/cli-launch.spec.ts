import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './cli-extract.ts';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hornbook-cli-'));
  roots.push(root);
  const dir = join(root, 'space & Unicode-é');
  mkdirSync(dir);
  writeFileSync(join(dir, 'argv.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  return dir;
}
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const args = [
  'safe&echo.AUDIT_INJECTED',
  'a|b',
  'a>b',
  '%PATH%',
  '!PATH!',
  'a^b',
  'a"b',
  'a b',
  '日本語',
  '',
  '(a)',
  'trailing\\',
];

describe('argument boundaries in the production CLI launcher', () => {
  it('preserves every argument with a native executable', async () => {
    const dir = fixture();
    const result = await runProcess(
      process.execPath,
      [join(dir, 'argv.cjs'), ...args],
      undefined,
      5000,
      dir,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(args);
  });

  it.skipIf(process.platform !== 'win32')(
    'runs a Node shim without interpreting shell syntax',
    async () => {
      const dir = fixture();
      const shim = join(dir, 'echo.cmd');
      writeFileSync(
        shim,
        '@ECHO off\r\nSET "dp0=%~dp0"\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\argv.cjs" %*\r\n',
      );
      const result = await runProcess(shim, args, undefined, 5000, dir);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual(args);
      expect(existsSync(join(dir, 'b'))).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'refuses unsupported batch scripts without executing them',
    async () => {
      const dir = fixture();
      const shim = join(dir, 'custom.bat');
      writeFileSync(shim, '@echo unsafe>executed.txt\r\n');
      await expect(runProcess(shim, ['safe'], undefined, 5000, dir)).rejects.toThrow(
        /unsupported.*shim/i,
      );
      expect(existsSync(join(dir, 'executed.txt'))).toBe(false);
    },
  );
});
