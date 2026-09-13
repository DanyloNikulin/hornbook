import { describe, expect, it } from 'vitest';
import { msixIdentity, msixManifest, msixVersion, PREVIEW_IDENTITY } from './msix.ts';

describe('MSIX package identity', () => {
  it('requires real Store metadata unless local preview is explicit', () => {
    expect(() => msixIdentity(false, {})).toThrow('Partner Center');
    expect(msixIdentity(true, {})).toEqual(PREVIEW_IDENTITY);
    expect(() => msixIdentity(false, {
      HORNBOOK_STORE_IDENTITY_NAME: PREVIEW_IDENTITY.name,
      HORNBOOK_STORE_PUBLISHER: PREVIEW_IDENTITY.publisher,
      HORNBOOK_STORE_PUBLISHER_DISPLAY_NAME: 'Example',
      HORNBOOK_STORE_DISPLAY_NAME: 'Example',
    })).toThrow('must not be submitted');
  });
  it('reserves the fourth version component for Store', () => {
    expect(msixVersion('0.9.9')).toBe('1.9.9.0');
    expect(msixVersion('1.0.0')).toBe('2.0.0.0');
    expect(msixVersion('65534.65535.65535')).toBe('65535.65535.65535.0');
    for (const invalid of ['0.9.9-beta', '0.9.9.1', '65535.0.0', '65536.0.0', '0.65536.0', '0.0.65536', '01.2.3']) {
      expect(() => msixVersion(invalid)).toThrow();
    }
  });
  it('escapes publisher metadata and declares a desktop application, without elevation or startup', () => {
    const xml = msixManifest({ ...PREVIEW_IDENTITY, publisher: 'CN=Test & "Example"' }, '0.9.9', 'x64');
    expect(xml).toContain('CN=Test &amp; &quot;Example&quot;');
    expect(xml).toContain('Executable="app\\Hornbook.exe"');
    expect(xml).toContain('runFullTrust');
    expect(xml).not.toContain('allowElevation');
    expect(xml).not.toContain('startupTask');
  });
});
