import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageVersion } from './runtime.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('packageVersion', () => {
  it('reads a stable semantic version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornbook-version-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.9.0' }));
    expect(packageVersion(dir)).toBe('0.9.0');
  });

  it('accepts prerelease versions and rejects malformed versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornbook-version-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.9.0-beta.1' }));
    expect(packageVersion(dir)).toBe('0.9.0-beta.1');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: 'next' }));
    expect(() => packageVersion(dir)).toThrow(/Invalid Hornbook version/);
  });
});
