// Average-hash perceptual fingerprint. 64 bits, robust to compression and
// minor pixel noise. Two near-identical frames will have low Hamming distance.

const SIZE = 8;

/** Average hash from an ffmpeg-produced 8×8 grayscale raster. */
export function aHash(raw: Uint8Array): Uint8Array {
  if (raw.length !== SIZE * SIZE) throw new Error(`aHash needs 64 grayscale bytes, got ${raw.length}`);
  let sum = 0;
  for (const b of raw) sum += b;
  const mean = sum / raw.length;

  const bits = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    if (raw[i] > mean) bits[i >> 3] |= 1 << (i & 7);
  }
  return bits;
}

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = a[i] ^ b[i];
    while (xor) {
      d += xor & 1;
      xor >>= 1;
    }
  }
  return d;
}
