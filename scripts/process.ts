#!/usr/bin/env node
// Orchestrator: input → <journal>/<section>/<date>-<slug>.json + .md
//
//   --from video      transcribe + frames + extract (default for .mp4)
//   --from audio      transcribe + extract, no frames
//   --from transcript skip ffmpeg; input is a .txt transcript
//   --from json       validate and copy an existing lesson JSON
//
// Usage: tsx scripts/process.ts <input> --date YYYY-MM-DD [--title title] [--section es-en]
//        [--from video|audio|transcript|json] [--workdir dir]

import { retainFailedCleanup } from './lib/cli-failure.ts';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { transcribe } from './transcribe.ts';
import { extractFrames } from './extract-frames.ts';
import { extract } from './extract.ts';
import { finalizeLesson } from './lib/lesson-storage.ts';
import { Lesson, type LessonT } from '../src/lib/schema.ts';
import { existingSlugs, repoRootDir, resolveSectionArg, sectionDir, writeCanonicalLesson } from './lib/cli-journal.ts';
import { ensureUniqueSlug, slugify } from './lib/slug.ts';
import { currentProviders } from './lib/config.ts';
import { isMain } from './lib/is-main.ts';

type From = 'video' | 'audio' | 'transcript' | 'json';
type ProcessStage = 'hearing' | 'slides' | 'writing' | 'checking';
type ProcessStageStatus = 'running' | 'done' | 'skipped';

function reportStage(id: ProcessStage, status: ProcessStageStatus): void {
  console.log(`HORNBOOK_STAGE ${JSON.stringify({ id, status })}`);
}

interface Args {
  input: string;
  date: string;
  title: string | null;
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
  const args: { input: string | null; date: string | null; title: string | null; workdir: string | null; from: From | null } = {
    input: null,
    date: null,
    title: null,
    workdir: null,
    from: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i] ?? null;
    else if (a === '--title') args.title = argv[++i]?.trim() || null;
    else if (a === '--workdir') args.workdir = argv[++i] ?? null;
    else if (a === '--from') args.from = argv[++i] as From;
    else if (a === '--section') i++;
    else if (!a.startsWith('--')) args.input = a;
  }
  if (!args.input) {
    console.error(
      'Usage: tsx scripts/process.ts <input> --date YYYY-MM-DD [--title title] [--section id] [--from video|audio|transcript|json]',
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
    title: args.title,
    from,
    workdir:
      args.workdir ??
      join(process.env['HORNBOOK_WORK']?.trim() || join(repoRootDir(), 'work'), basename(args.input, extname(args.input))),
  };
}

/** Write a lesson into a section and refresh that section's derived data. */
export function writeLesson(sectionId: string, lesson: LessonT): { jsonPath: string; mdPath: string } {
  const canonical = writeCanonicalLesson(sectionId, lesson);
  const dir = sectionDir(sectionId);
  return { jsonPath: join(dir, `${canonical.id}.json`), mdPath: join(dir, `${canonical.id}.md`) };
}

export function applyInputDetails(sectionId: string, lesson: LessonT, date: string, title: string | null): LessonT {
  const requestedSlug = title ? slugify(title) || 'lesson' : lesson.slug;
  const slug = ensureUniqueSlug(requestedSlug, date, existingSlugs(sectionId));
  return finalizeLesson(lesson, { date, slug, ...(title ? { title } : {}) });
}

async function main(): Promise<void> {
  const section = resolveSectionArg(process.argv);
  const args = parseArgs(process.argv);
  const { input, date, title, workdir, from } = args;

  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }
  console.log(`Section: ${section.id} (${section.target} → ${section.learner})`);

  if (from === 'json') {
    reportStage('checking', 'running');
    const parsed = Lesson.safeParse(JSON.parse(readFileSync(input, 'utf8')));
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.format(), null, 2));
      process.exit(1);
    }
    const lesson = applyInputDetails(section.id, parsed.data, date, title);
    const out = writeLesson(section.id, lesson);
    reportStage('checking', 'done');
    console.log(`✓ ${out.jsonPath}`);
    console.log(`HORNBOOK_RESULT ${JSON.stringify({ slug: lesson.slug, id: lesson.id })}`);
    return;
  }

  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  if (from === 'transcript') {
    console.log('=== Transcript (skip transcribe/frames) ===');
    copyFileSync(input, join(workdir, 'transcript.txt'));
  } else if (currentProviders().transcribe.driver === 'skip') {
    console.error(
      'Hearing is skipped. Pass a .txt transcript, or set up whisper.cpp / OpenAI in Application settings.',
    );
    process.exit(1);
  } else {
    reportStage('hearing', 'running');
    console.log(`\n=== Transcribe (${from}) ===`);
    const transcript = await transcribe(input, workdir);
    writeFileSync(join(workdir, 'transcript.txt'), transcript, 'utf8');
    console.log(`✓ Transcript: ${transcript.length} chars`);
    reportStage('hearing', 'done');
  }

  if (from === 'video') {
    reportStage('slides', 'running');
    console.log(`\n=== Extract slide frames ===`);
    const frames = await extractFrames(input, workdir);
    console.log(`✓ Frames: ${frames.length} unique slides`);
    reportStage('slides', 'done');
  } else {
    console.log('=== Skip frames ===');
  }

  reportStage('writing', 'running');
  console.log(`\n=== Extract structured lesson ===`);
  let checking = false;
  const extracted = await extract(workdir, date, {
    onModelAnswer: () => {
      if (checking) return;
      checking = true;
      reportStage('writing', 'done');
      reportStage('checking', 'running');
    },
  });
  if (!checking) {
    reportStage('writing', 'done');
    reportStage('checking', 'running');
  }
  const lesson = applyInputDetails(section.id, extracted, date, title);
  console.log(`\n=== Writing lesson files ===`);
  const out = writeLesson(section.id, lesson);
  reportStage('checking', 'done');
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
    if (!retainFailedCleanup(err)) process.exit(1);
  });
}
