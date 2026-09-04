#!/usr/bin/env node
// Video → deduped slides pipeline.
//
//   1. ffmpeg samples 1 frame every 5 seconds (configurable). 60-min lesson -> 720 frames.
//   2. For each frame, compute an 8x8 average hash (aHash).
//   3. Walk in order, keep a frame only if its hash differs from the last KEPT frame
//      by more than HAMMING_THRESHOLD. This collapses long stretches where the teacher
//      stayed on one slide into a single sample.
//   4. Result: ~20-50 unique slides for a typical lesson.
//
// Usage: tsx scripts/extract-frames.ts <input> <out_dir>
// Produces: <out_dir>/frames/keep-*.jpg + frames-manifest.json

import { mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegBuffer } from './lib/ffmpeg.ts';
import { aHash, hamming } from './lib/phash.ts';
import { isMain } from './lib/is-main.ts';

const SAMPLE_EVERY_SEC = 5;
const HAMMING_THRESHOLD = 8;

export interface FrameRef {
  ts: string;
  seconds: number;
  file: string;
}

function timestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function extractFrames(inputPath: string, outDir: string): Promise<FrameRef[]> {
  const framesDir = join(outDir, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  // Split one sampled stream into recognizable JPGs and matching 8×8 rasters.
  console.log(`Sampling 1 frame every ${SAMPLE_EVERY_SEC}s...`);
  const rasters = await ffmpegBuffer([
    '-i',
    inputPath,
    '-filter_complex',
    `[0:v]fps=1/${SAMPLE_EVERY_SEC},split=2[images][hashes];[images]scale=960:-1[imageout];[hashes]scale=8:8,format=gray[hashout]`,
    '-map',
    '[imageout]',
    '-q:v',
    '6',
    join(framesDir, 'raw-%05d.jpg'),
    '-map',
    '[hashout]',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]);

  const allFiles = readdirSync(framesDir)
    .filter((f) => f.startsWith('raw-') && f.endsWith('.jpg'))
    .sort();
  console.log(`Sampled ${allFiles.length} frames.`);

  if (rasters.length !== allFiles.length * 64) {
    console.warn(`ffmpeg returned ${rasters.length} hash bytes for ${allFiles.length} frames; unmatched frames will be kept.`);
  }

  const kept: FrameRef[] = [];
  let lastHash: Uint8Array | null = null;
  for (const [i, file] of allFiles.entries()) {
    if ((i + 1) * 64 > rasters.length) {
      const ts = i * SAMPLE_EVERY_SEC;
      kept.push({ ts: timestamp(ts), seconds: ts, file });
      continue;
    }
    const hash = aHash(rasters.subarray(i * 64, (i + 1) * 64));
    if (lastHash === null || hamming(lastHash, hash) >= HAMMING_THRESHOLD) {
      const ts = i * SAMPLE_EVERY_SEC;
      kept.push({ ts: timestamp(ts), seconds: ts, file });
      lastHash = hash;
    }
  }
  console.log(`Kept ${kept.length} unique frames after dedupe (threshold ${HAMMING_THRESHOLD}).`);

  // Rename kept files to keep-NNN-HH:MM:SS.jpg for human inspection + remove raw-*.
  const { renameSync, unlinkSync } = await import('node:fs');
  const renamed: FrameRef[] = kept.map((k, i) => {
    const newName = `keep-${String(i).padStart(3, '0')}-${k.ts.replaceAll(':', '_')}.jpg`;
    renameSync(join(framesDir, k.file), join(framesDir, newName));
    return { ts: k.ts, seconds: k.seconds, file: newName };
  });

  for (const f of allFiles) {
    try {
      unlinkSync(join(framesDir, f));
    } catch {
      // already renamed or doesn't exist; ignore
    }
  }

  const manifestPath = join(outDir, 'frames-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(renamed, null, 2), 'utf8');

  return renamed;
}

async function cli(): Promise<void> {
  const [, , input, outDir = './out'] = process.argv;
  if (!input) {
    console.error('Usage: tsx scripts/extract-frames.ts <video-file> [out-dir]');
    process.exit(1);
  }
  const frames = await extractFrames(input, outDir);
  console.log(`\n✓ ${frames.length} unique frames -> ${outDir}/frames/`);
}

if (isMain(import.meta.url)) {
  cli().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
