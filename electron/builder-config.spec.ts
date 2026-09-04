import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../electron-builder.config.cjs') as {
  nsis: { artifactName: string };
  portable: { artifactName: string };
};

describe('electron-builder release artifacts', () => {
  it('keeps the installer and portable executable under distinct names', () => {
    expect(config.nsis.artifactName).toContain('-setup.');
    expect(config.portable.artifactName).toContain('-portable.');
    expect(config.nsis.artifactName).not.toBe(config.portable.artifactName);
  });
});
