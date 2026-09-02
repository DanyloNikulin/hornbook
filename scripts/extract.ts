#!/usr/bin/env node
// Transcript + slide frames → validated lesson.json via Claude Sonnet 4.6 with vision + tool use.
//
// Tool use forces the exact JSON schema — no field-name guessing by the model.
//
// Usage: tsx scripts/extract.ts <work_dir> <date_hint>

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { ensureUniqueSlug } from './lib/slug.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lesson, TOPIC_VOCAB, type LessonT, type TopicT } from '../src/lib/schema.ts';
import {
  buildLessonTool,
  buildSystemPrompt,
  userMessageForLesson,
  type ExistingLessonRef,
} from './lib/prompt.ts';
import { detectTopics, formatTopics } from './lib/topics.ts';
import { coerceStringifiedFields } from './lib/tool-input-repair.ts';
import { getExtractor } from './providers/index.ts';
import type { ExtractMessagePart } from './providers/types.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lessonsDir = join(repoRoot, 'lessons');
const SUGGESTIONS_PATH = join(lessonsDir, '_topics-suggestions.json');

// Accumulated AI-side suggestions for vocab gaps. Each suggested topic ID is
// keyed; we track count + lesson slugs to make Tier 2 vocab-review able to
// see "this topic has been suggested 5 times across these lessons".
interface SuggestionsFile {
  schema_version: 1;
  topics: Record<
    string,
    {
      count: number;
      first_seen: string; // ISO date (lesson date)
      last_seen: string;
      lessons: string[]; // lesson slugs, dedup'd
    }
  >;
}

function loadSuggestions(): SuggestionsFile {
  if (!existsSync(SUGGESTIONS_PATH)) {
    return { schema_version: 1, topics: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(SUGGESTIONS_PATH, 'utf8'));
    if (raw?.schema_version === 1 && raw.topics && typeof raw.topics === 'object') {
      return raw as SuggestionsFile;
    }
  } catch {
    // fall through to fresh
  }
  return { schema_version: 1, topics: {} };
}

function recordSuggestions(
  newSuggestions: readonly string[],
  lessonSlug: string,
  lessonDate: string,
): void {
  if (newSuggestions.length === 0) return;
  const file = loadSuggestions();
  for (const topic of newSuggestions) {
    const entry = file.topics[topic];
    if (!entry) {
      file.topics[topic] = {
        count: 1,
        first_seen: lessonDate,
        last_seen: lessonDate,
        lessons: [lessonSlug],
      };
    } else if (!entry.lessons.includes(lessonSlug)) {
      entry.count += 1;
      entry.last_seen = lessonDate;
      entry.lessons.push(lessonSlug);
    }
  }
  writeFileSync(SUGGESTIONS_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

// Number of most-recent lessons to use as a safety-net candidate set when
// the regex tagger found no topics in the transcript (e.g. a free-form
// conversation lesson with no labelled grammar terms).
const FALLBACK_RECENT_LESSONS = 10;

function loadExistingLessons(filterTopics: readonly TopicT[]): ExistingLessonRef[] {
  if (!existsSync(lessonsDir)) return [];
  const files = readdirSync(lessonsDir).filter((f) => f.endsWith('.json'));
  const refs: ExistingLessonRef[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(lessonsDir, f), 'utf8');
      const parsed = Lesson.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      refs.push({
        slug: parsed.data.slug,
        date: parsed.data.date,
        title: parsed.data.title,
        summary: parsed.data.summary,
        topics: parsed.data.topics,
      });
    } catch {
      // skip malformed
    }
  }
  // Newest first — most likely to be similar in style/topic.
  refs.sort((a, b) => (a.date < b.date ? 1 : -1));

  if (filterTopics.length === 0) {
    const limited = refs.slice(0, FALLBACK_RECENT_LESSONS);
    console.log(
      `No preliminary topics — falling back to ${limited.length} most-recent lessons as candidates.`,
    );
    return limited;
  }

  const overlap = refs.filter((r) =>
    r.topics.some((t) => filterTopics.includes(t)),
  );
  console.log(
    `Candidate filter: ${overlap.length} of ${refs.length} lesson(s) share a topic with new lesson.`,
  );
  return overlap;
}

// slug → file name for EVERY committed lesson, regardless of topic overlap.
// loadExistingLessons() above is filtered to related-candidates; slug
// uniqueness must be checked against the whole catalog (issue #65).
function loadExistingSlugs(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(lessonsDir)) return out;
  const files = readdirSync(lessonsDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(lessonsDir, f), 'utf8')) as { slug?: unknown };
      if (typeof raw.slug === 'string') out.set(raw.slug, f);
    } catch {
      // Malformed lesson file — build-derived reports it; not our concern here.
    }
  }
  return out;
}

export async function extract(workDir: string, dateHint: string): Promise<LessonT> {
  const transcriptPath = join(workDir, 'transcript.txt');
  const manifestPath = join(workDir, 'frames-manifest.json');
  const framesDir = join(workDir, 'frames');
  const logsDir = join(workDir, 'logs');
  mkdirSync(logsDir, { recursive: true });

  const transcript = readFileSync(transcriptPath, 'utf8');
  const framesManifest: { ts: string; file: string }[] = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : [];

  const preliminaryTopics = detectTopics(transcript);
  console.log(`Preliminary topics (regex): ${formatTopics(preliminaryTopics)}`);

  const existingLessons = loadExistingLessons(preliminaryTopics);
  console.log(
    `Extract: ${transcript.length} chars transcript, ${framesManifest.length} slide(s), ${existingLessons.length} candidate lesson(s) in context.`,
  );

  const userText = userMessageForLesson({
    transcript,
    dateHint,
    framesManifest,
    existingLessons,
    preliminaryTopics,
  });

  const extractor = getExtractor();
  const userParts: ExtractMessagePart[] = [{ type: 'text', text: userText }];
  if (extractor.supportsVision) {
    for (const f of framesManifest) {
      const imgPath = join(framesDir, f.file);
      if (!existsSync(imgPath)) {
        console.warn(`Skipping missing frame ${f.file}`);
        continue;
      }
      userParts.push({ type: 'image', imageJpeg: readFileSync(imgPath) });
    }
  } else if (framesManifest.length > 0) {
    console.warn(`Extract driver ${extractor.driver} has no vision — skipping ${framesManifest.length} slide(s).`);
  }

  const lessonTool = buildLessonTool();
  console.log(`Extract via ${extractor.driver} (${userParts.filter((p) => p.type === 'image').length} image(s))...`);

  const rawInput = await extractor.extract({
    system: buildSystemPrompt(),
    userParts,
    jsonSchema: lessonTool.input_schema,
    toolName: lessonTool.name,
  });

  writeFileSync(join(logsDir, 'tool-input.json'), JSON.stringify(rawInput, null, 2), 'utf8');

  const toolInput = rawInput as Record<string, unknown>;

  // Defensive: the model occasionally returns an array field as a JSON-encoded
  // string (double encoding), sometimes with broken inner quote escaping
  // (run 29360203093). Repair what's repairable before validation — loudly;
  // anything unrepairable still fails the Zod parse below as before.
  for (const msg of coerceStringifiedFields(toolInput)) {
    console.warn(`⚠ Tool input coercion: ${msg}`);
  }

  const rawSuggestions = toolInput['suggested_new_topics'];
  const suggestedNewTopics: string[] = Array.isArray(rawSuggestions)
    ? rawSuggestions.filter(
        (t: unknown): t is string =>
          typeof t === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t),
      )
    : [];

  const result = Lesson.safeParse(toolInput);
  if (!result.success) {
    writeFileSync(
      join(logsDir, 'validation-errors.json'),
      JSON.stringify(result.error.format(), null, 2),
      'utf8',
    );
    throw new Error(
      `Lesson JSON failed Zod validation. See ${join(logsDir, 'validation-errors.json')}.`,
    );
  }

  // The slug is model-generated. The site routes by slug alone and
  // cheatsheet.json keys processed lessons by slug, so a collision with an
  // existing lesson silently shadows one of them (issue #65). Re-processing
  // the same lesson (same date + slug) is allowed — process.ts overwrites it.
  const uniqueSlug = ensureUniqueSlug(result.data.slug, result.data.date, loadExistingSlugs());
  if (uniqueSlug !== result.data.slug) {
    console.warn(
      `⚠ Slug "${result.data.slug}" is already used by another lesson — using "${uniqueSlug}".`,
    );
    result.data.slug = uniqueSlug;
    result.data.id = `${result.data.date}-${uniqueSlug}`;
  }

  // Defensive filter: AI sometimes hallucinates slug references. Drop any
  // 'related' entries that don't match a candidate we actually sent, plus
  // the current slug.
  const validSlugs = new Set(existingLessons.map((l) => l.slug));
  const cleanedRelated = result.data.related.filter(
    (s) => validSlugs.has(s) && s !== result.data.slug,
  );
  if (cleanedRelated.length !== result.data.related.length) {
    const dropped = result.data.related.filter((s) => !cleanedRelated.includes(s));
    console.warn(`Dropped non-existent 'related' slugs: ${dropped.join(', ')}`);
    result.data.related = cleanedRelated;
  }

  // Fallback: if AI returned empty topics (rare — usually means the lesson
  // is a free-form conversation it couldn't categorize, or the tool call
  // misfired) but regex found something, take regex result as the floor.
  // Better to have noisy topics than empty ones — empty topics means future
  // lessons can't use this one as a candidate via topic overlap.
  if (result.data.topics.length === 0 && preliminaryTopics.length > 0) {
    console.warn(
      `AI returned empty topics — using regex preliminary as fallback: ${formatTopics(preliminaryTopics)}`,
    );
    result.data.topics = [...preliminaryTopics];
  }

  // Diagnostics: where does the AI's topic list diverge from the regex pass?
  // Useful when tuning the regex tagger — large divergence means the regex
  // is missing patterns or over-firing.
  const aiTopics = result.data.topics;
  const regexDropped = preliminaryTopics.filter((t) => !aiTopics.includes(t));
  const aiAdded = aiTopics.filter((t) => !preliminaryTopics.includes(t));
  if (regexDropped.length > 0) {
    console.log(`AI dropped regex topics: ${regexDropped.join(', ')}`);
  }
  if (aiAdded.length > 0) {
    console.log(`AI added beyond regex: ${aiAdded.join(', ')}`);
  }
  console.log(`Final topics: ${formatTopics(aiTopics)}`);

  // Record AI's vocab-gap suggestions for the monthly Tier 2 review.
  // Filter out IDs that are already in TOPIC_VOCAB — AI shouldn't suggest
  // those but be defensive so the suggestions file stays meaningful.
  const vocabSet = new Set<string>(TOPIC_VOCAB);
  const filteredSuggestions = suggestedNewTopics.filter((s) => !vocabSet.has(s));
  if (filteredSuggestions.length > 0) {
    recordSuggestions(filteredSuggestions, result.data.slug, result.data.date);
    console.log(`AI suggested new topics for vocab review: ${filteredSuggestions.join(', ')}`);
  }

  const lessonPath = join(workDir, 'lesson.json');
  writeFileSync(lessonPath, JSON.stringify(result.data, null, 2), 'utf8');
  console.log(`✓ Valid lesson.json -> ${lessonPath} (related: ${result.data.related.length})`);

  return result.data;
}

async function cli(): Promise<void> {
  const [, , workDir, dateHint] = process.argv;
  if (!workDir || !dateHint) {
    console.error('Usage: tsx scripts/extract.ts <work_dir> <YYYY-MM-DD>');
    process.exit(1);
  }
  await extract(workDir, dateHint);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  cli().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
