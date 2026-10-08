#!/usr/bin/env node
// Audio → transcript. ffmpeg cuts the recording into mono 16 kHz chunks in
// the container the configured transcriber reads (opus for OpenAI, WAV for
// whisper.cpp — see lib/audio-chunk.ts) and as long as it asks for (three
// minutes for OpenAI, whose answer is capped; a quarter hour for whisper.cpp);
// the transcriber turns each into text.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, durationSeconds } from './lib/ffmpeg.ts';
import { chunkEncodeArgs, chunkFileName, type ChunkFormat } from './lib/audio-chunk.ts';
import { learnerLanguageName, targetLanguageName } from './lib/config.ts';
import { getTranscriber } from './providers/index.ts';
import { isMain } from './lib/is-main.ts';

/**
 * Where each chunk starts and how long it runs: `chunkSeconds` apart, each
 * running `overlapSeconds` into the next. A chunk whose overlap already
 * reaches the end is the last one: a recording a hair longer than a whole
 * number of chunks would otherwise end in a 0.02 s chunk, which OpenAI
 * rejects as corrupted audio.
 */
export function planChunks(
  total: number,
  chunkSeconds: number,
  overlapSeconds: number,
): { start: number; dur: number }[] {
  const chunks: { start: number; dur: number }[] = [];
  for (let start = 0; start < total; start += chunkSeconds) {
    const dur = Math.min(chunkSeconds + overlapSeconds, total - start);
    chunks.push({ start, dur });
    if (start + dur >= total) break;
  }
  return chunks;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function lessonHint(): string {
  return (
    `A ${targetLanguageName()} language lesson. The teacher may explain in ` +
    `${learnerLanguageName()} and give examples in ${targetLanguageName()}. ` +
    `Preserve ${targetLanguageName()} spelling exactly.`
  );
}

async function extractChunk(
  input: string,
  outPath: string,
  start: number,
  duration: number,
  format: ChunkFormat,
): Promise<void> {
  await ffmpeg([
    '-ss',
    String(start),
    '-t',
    String(duration),
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    ...chunkEncodeArgs(format),
    outPath,
  ]);
}

export async function transcribe(inputPath: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const transcriber = getTranscriber();
  const hint = lessonHint();

  const total = await durationSeconds(inputPath);
  console.log(
    `Duration: ${fmt(total)} (${total.toFixed(1)}s) via ${transcriber.driver}, ${transcriber.chunkFormat} chunks`,
  );

  const chunks = planChunks(total, transcriber.chunkSeconds, transcriber.overlapSeconds).map((c, i) => ({
    ...c,
    path: join(outDir, chunkFileName(i, transcriber.chunkFormat)),
  }));
  console.log(`Splitting into ${chunks.length} chunk(s).`);

  const transcripts: { start: number; end: number; text: string }[] = [];
  for (const [i, c] of chunks.entries()) {
    console.log(`Chunk ${i + 1}/${chunks.length}: ${fmt(c.start)}–${fmt(c.start + c.dur)}`);
    await extractChunk(inputPath, c.path, c.start, c.dur, transcriber.chunkFormat);
    const text = await transcriber.transcribe(c.path, hint, c.dur);
    transcripts.push({ start: c.start, end: c.start + c.dur, text: text.trim() });
  }

  return transcripts
    .map((t) => `\n\n[${fmt(t.start)}–${fmt(t.end)}]\n${t.text}`)
    .join('\n')
    .trim();
}

async function cli(): Promise<void> {
  const [, , input, outDir = './out'] = process.argv;
  if (!input) {
    console.error('Usage: tsx scripts/transcribe.ts <audio-or-video-file> [out-dir]');
    process.exit(1);
  }
  const text = await transcribe(input, outDir);
  const transcriptPath = join(outDir, 'transcript.txt');
  writeFileSync(transcriptPath, text, 'utf8');
  console.log(`\n✓ Transcript -> ${transcriptPath} (${text.length} chars)`);
}

if (isMain(import.meta.url)) {
  cli().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
