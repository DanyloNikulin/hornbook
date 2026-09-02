// Average-hash perceptual fingerprint. 64 bits, robust to compression and
// minor pixel noise. Two near-identical frames will have low Hamming distance.

import sharp from 'sharp';

const SIZE = 8;

export async function aHash(path: string): Promise<Uint8Array> {
  const raw = await sharp(path)
    .resize(SIZE, SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

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
