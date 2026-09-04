import { describe, expect, it } from 'vitest';
import { aHash, hamming } from './phash.ts';

describe('average hash', () => {
  it('hashes a 64-byte grayscale raster and compares bit distance', () => {
    const ramp = Uint8Array.from({ length: 64 }, (_, i) => i);
    const inverse = Uint8Array.from(ramp, (value) => 63 - value);
    expect(aHash(ramp)).toHaveLength(8);
    expect(hamming(aHash(ramp), aHash(ramp))).toBe(0);
    expect(hamming(aHash(ramp), aHash(inverse))).toBe(64);
  });

  it('rejects a raster of the wrong size', () => {
    expect(() => aHash(new Uint8Array(63))).toThrow(/64 grayscale bytes/);
  });
});
