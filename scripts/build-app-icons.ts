#!/usr/bin/env node
// Rasterize the canonical SVG and wrap the PNGs in the native desktop icon
// containers expected by electron-builder. Run with `npm run build-icons`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { repoRootDir } from './lib/cli-journal.ts';

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024] as const;

async function main(): Promise<void> {
  const root = repoRootDir();
  const out = join(root, 'build');
  const source = readFileSync(join(root, 'public', 'favicon.svg'));
  mkdirSync(out, { recursive: true });

  const images = new Map<number, Buffer>();
  for (const size of sizes) {
    images.set(size, await sharp(source).resize(size, size).png().toBuffer());
  }
  writeFileSync(join(out, 'icon.png'), images.get(1024)!);
  writeFileSync(join(out, 'icon.ico'), ico([16, 32, 48, 256].map((size) => [size, images.get(size)!] as const)));
  writeFileSync(
    join(out, 'icon.icns'),
    icns([
      ['icp4', images.get(16)!],
      ['icp5', images.get(32)!],
      ['icp6', images.get(64)!],
      ['ic07', images.get(128)!],
      ['ic08', images.get(256)!],
      ['ic09', images.get(512)!],
      ['ic10', images.get(1024)!],
    ]),
  );
  console.log(`Wrote ${join(out, 'icon.{png,ico,icns}')}`);
}

function ico(images: readonly (readonly [number, Buffer])[]): Buffer {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [[size, image], index] of images.map((entry, index) => [entry, index] as const)) {
    const at = 6 + index * 16;
    header[at] = size >= 256 ? 0 : size;
    header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.length;
  }
  return Buffer.concat([header, ...images.map(([, image]) => image)]);
}

function icns(images: readonly (readonly [string, Buffer])[]): Buffer {
  const chunks = images.map(([type, image]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(image.length + header.length, 4);
    return Buffer.concat([header, image]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(header.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
