import { describe, expect, it } from 'vitest';
import { unpackedFolder } from '../harness/package-output.ts';

describe('packaged Electron output selection', () => {
  it('does not launch an ARM64 package on x64 Windows', () => {
    expect(unpackedFolder('win32', 'x64', ['win-arm64-unpacked', 'win-unpacked'])).toBe('win-unpacked');
  });

  it('prefers the native ARM64 package where electron-builder names one', () => {
    expect(unpackedFolder('win32', 'arm64', ['win-unpacked', 'win-arm64-unpacked'])).toBe('win-arm64-unpacked');
    expect(unpackedFolder('darwin', 'arm64', ['mac', 'mac-arm64'])).toBe('mac-arm64');
    expect(unpackedFolder('linux', 'arm64', ['linux-unpacked', 'linux-arm64-unpacked'])).toBe(
      'linux-arm64-unpacked',
    );
  });
});
