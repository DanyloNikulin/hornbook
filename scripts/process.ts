#!/usr/bin/env node
// Orchestrator: input → <journal>/<section>/<date>-<slug>.json + .md
//
//   --from video      transcribe + frames + extract (default for .mp4)
//   --from audio      transcribe + extract, no frames
//   --from transcript skip ffmpeg; input is a .txt transcript
//   --from json       validate and copy an existing lesson JSON
//
// Usage: tsx scripts/process.ts <input> --date YYYY-MM-DD [--section es-en]
//        [--from video|audio|transcript|json] [--workdir dir]

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { transcribe } from './transcribe.ts';
import { extractFrames } from './extract-frames.ts';
import { extract } from './extract.ts';
import { lessonToMarkdown } from './lib/markdown.ts';
import { Lesson, type LessonT } from '../src/lib/schema.ts';
import { repoRootDir, resolveSectionArg, sectionDir, writeDerived, lessonFileStem } from './lib/journal.ts';
import { isMain } from './lib/is-main.ts';

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
  const args: { input: string | null; date: string | null; workdir: string | null; from: From | null } = {
    input: null,
    date: null,
    workdir: null,
    from: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i] ?? null;
    else if (a === '--workdir') args.workdir = argv[++i] ?? null;
    else if (a === '--from') args.from = argv[++i] as From;
    else if (a === '--section') i++;
    else if (!a.startsWith('--')) args.input = a;
  }
  if (!args.input) {
    console.error(
      'Usage: tsx scripts/process.ts <input> --date YYYY-MM-DD [--section id] [--from video|audio|transcript|json]',
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
    workdir: args.workdir ?? join(repoRootDir(), 'work', basename(args.input, extname(args.input))),
  };
}

/** Write a lesson into a section and refresh that section's derived data. */
export function writeLesson(sectionId: string, lesson: LessonT): { jsonPath: string; mdPath: string } {
  const dir = sectionDir(sectionId);
  mkdirSync(dir, { recursive: true });
  const stem = lessonFileStem(lesson);
  if (lesson.id !== stem) lesson.id = stem;
  const jsonPath = join(dir, `${stem}.json`);
  const mdPath = join(dir, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(lesson, null, 2) + '\n', 'utf8');
  writeFileSync(mdPath, lessonToMarkdown(lesson), 'utf8');
  writeDerived(sectionId);
  return { jsonPath, mdPath };
}

async function main(): Promise<void> {
  const section = resolveSectionArg(process.argv);
  const args = parseArgs(process.argv);
  const { input, date, workdir, from } = args;

  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }
  console.log(`Section: ${section.id} (${section.target} → ${section.learner})`);

  if (from === 'json') {
    const parsed = Lesson.safeParse(JSON.parse(readFileSync(input, 'utf8')));
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.format(), null, 2));
      process.exit(1);
    }
    const out = writeLesson(section.id, parsed.data);
    console.log(`✓ ${out.jsonPath}`);
    console.log(`HORNBOOK_RESULT ${JSON.stringify({ slug: parsed.data.slug, id: parsed.data.id })}`);
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
  const out = writeLesson(section.id, lesson);
  console.log(`✓ ${out.jsonPath}`);
  console.log(`✓ ${out.mdPath}`);
  console.log(`Workdir kept at ${workdir}`);
  console.log(`HORNBOOK_RESULT ${JSON.stringify({ slug: lesson.slug, id: lesson.id })}`);
  console.log('\nDone.');
}

if (isMain(import.meta.url)) {
  main().catch((err: unknown) => {
    const e = err as Error;
    console.error('\n✘', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
}
