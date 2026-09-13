import { describe, expect, it } from 'vitest';
import { storeDistribution } from './distribution.ts';

describe('Store distribution', () => {
  it('recognizes both installed and unpacked Store builds', () => {
    expect(storeDistribution(true, {})).toBe(true);
    expect(storeDistribution(false, { hornbookDistribution: 'microsoft-store' })).toBe(true);
  });
  it('keeps ordinary installers on their existing update channel', () => {
    expect(storeDistribution(undefined, {})).toBe(false);
    expect(storeDistribution(false, { hornbookDistribution: 'direct' })).toBe(false);
  });
});
