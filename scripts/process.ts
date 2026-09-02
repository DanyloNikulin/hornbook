#!/usr/bin/env node
// Orchestrator: input → lessons/<date>-<slug>.json + .md
//
//   --from video      transcribe + frames + extract (default for .mp4)
//   --from audio      transcribe + extract, no frames
//   --from transcript skip ffmpeg; input is a .txt transcript
//   --from json       validate and copy an existing lesson JSON
//
// Usage: tsx scripts/process.ts <input> --date YYYY-MM-DD [--from video|audio|transcript|json]

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribe } from './transcribe.ts';
import { extractFrames } from './extract-frames.ts';
import { extract } from './extract.ts';
import { lessonToMarkdown } from './lib/markdown.ts';
import { Lesson } from '../src/lib/schema.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

type From = 'video' | 'audio' | 'transcript' | 'json';

interface Args {
  input: string;
  date: string;
  workdir: string;
  from: From;
}

function inferFrom(path: string): From {
  const ext = extname(path).toLowerCase();
  if (ext === '.txt' || ext === '.vtt' || ext === '.srt') return 'transcript';
  if (ext === '.json') return 'json';
  if (['.m4a', '.mp3', '.wav', '.ogg', '.opus', '.aac'].includes(ext)) return 'audio';
  return 'video';
}

function parseArgs(argv: string[]): Args {
  const args: {
    input: string | null;
    date: string | null;
    workdir: string | null;
    from: From | null;
  } = { input: null, date: null, workdir: null, from: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i] ?? null;
    else if (a === '--workdir') args.workdir = argv[++i] ?? null;
    else if (a === '--from') args.from = argv[++i] as From;
    else if (!a.startsWith('--')) args.input = a;
  }
  if (!args.input) {
    console.error(
      'Usage: tsx scripts/process.ts <input> --date YYYY-MM-DD [--from video|audio|transcript|json]',
    );
    process.exit(1);
  }
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error(`Error: --date YYYY-MM-DD is required (got ${args.date ? `"${args.date}"` : 'none'}).`);
    process.exit(1);
  }
  const from = args.from ?? inferFrom(args.input);
  if (!['video', 'audio', 'transcript', 'json'].includes(from)) {
    console.error(`Error: unknown --from ${from}`);
    process.exit(1);
  }
  return {
    input: args.input,
    date: args.date,
    from,
    workdir: args.workdir ?? join(repoRoot, 'work', basename(args.input, extname(args.input))),
  };
}

function writeLesson(lesson: ReturnType<typeof Lesson.parse>, workdir: string): void {
  const lessonsDir = join(repoRoot, 'lessons');
  mkdirSync(lessonsDir, { recursive: true });
  const stem = `${lesson.date}-${lesson.slug}`;
  if (lesson.id !== stem) lesson.id = stem;
  const jsonPath = join(lessonsDir, `${stem}.json`);
  const mdPath = join(lessonsDir, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(lesson, null, 2), 'utf8');
  writeFileSync(mdPath, lessonToMarkdown(lesson), 'utf8');
  console.log(`✓ ${jsonPath}`);
  console.log(`✓ ${mdPath}`);
  console.log(`Workdir kept at ${workdir}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const { input, date, workdir, from } = args;

  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }

  if (from === 'json') {
    const parsed = Lesson.safeParse(JSON.parse(readFileSync(input, 'utf8')));
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.format(), null, 2));
      process.exit(1);
    }
    mkdirSync(workdir, { recursive: true });
    writeLesson(parsed.data, workdir);
    return;
  }

  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  if (from === 'transcript') {
    console.log('=== Transcript (skip transcribe/frames) ===');
    copyFileSync(input, join(workdir, 'transcript.txt'));
  } else {
    console.log(`\n=== Transcribe (${from}) ===`);
    const transcript = await transcribe(input, workdir);
    writeFileSync(join(workdir, 'transcript.txt'), transcript, 'utf8');
    console.log(`✓ Transcript: ${transcript.length} chars`);
  }

  if (from === 'video') {
    console.log(`\n=== Extract slide frames ===`);
    const frames = await extractFrames(input, workdir);
    console.log(`✓ Frames: ${frames.length} unique slides`);
  } else {
    console.log('=== Skip frames ===');
  }

  console.log(`\n=== Extract structured lesson ===`);
  const lesson = await extract(workdir, date);
  console.log(`\n=== Writing lesson files ===`);
  writeLesson(lesson, workdir);
  console.log('\nDone.');
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error('\n✘', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
