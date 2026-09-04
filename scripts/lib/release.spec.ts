import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './release.ts';

const pkg = JSON.stringify({ name: 'hornbook', version: '0.9.0' });
const lock = JSON.stringify({ name: 'hornbook', version: '0.9.0', packages: { '': { version: '0.9.0' } } });
const changelog = '# Changelog\n\n## Unreleased\n\n## 0.9.0 — 2026-09-04\n\n- Product preview.\n\n## 0.1.0 — 2026-01-01\n';

describe('release metadata', () => {
  it('extracts notes only when package, lock, tag and changelog agree', () => {
    expect(releaseMetadata(pkg, lock, changelog, 'v0.9.0')).toEqual({
      version: '0.9.0',
      tag: 'v0.9.0',
      notes: '- Product preview.',
    });
  });

  it('rejects mismatched tags and lockfiles', () => {
    expect(() => releaseMetadata(pkg, lock, changelog, 'v1.0.0')).toThrow(/tag must be v0\.9\.0/);
    expect(() => releaseMetadata(pkg, lock.replaceAll('0.9.0', '0.8.0'), changelog)).toThrow(/not aligned/);
  });

  it('requires dated, finished changelog notes', () => {
    expect(() => releaseMetadata(pkg, lock, changelog.replace('Product preview.', 'TBD'))).toThrow(/finished notes/);
    expect(() => releaseMetadata(pkg, lock, '# Changelog\n\n## Unreleased\n')).toThrow(/no dated/);
  });
});
