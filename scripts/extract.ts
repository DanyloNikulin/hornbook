#!/usr/bin/env node
// Transcript + slide frames → validated lesson.json via Claude Sonnet 4.6 with vision + tool use.
//
// Tool use forces the exact JSON schema — no field-name guessing by the model.
//
// Usage: tsx scripts/extract.ts <work_dir> <date_hint>

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { ensureUniqueSlug } from './lib/slug.ts';
import { join } from 'node:path';
import type { LessonT, TopicT } from '../src/lib/schema.ts';
import {
  buildLessonTool,
  buildSystemPrompt,
  userMessageForLesson,
  type ExistingLessonRef,
} from './lib/prompt.ts';
import { detectTopics, formatTopics } from './lib/topics.ts';
import { extractValidated } from './lib/extract-validate.ts';
import { getExtractor } from './providers/index.ts';
import type { ExtractMessagePart } from './providers/types.ts';
import {
  currentSection,
  existingSlugs,
  readSectionLessons,
  readTopicCatalog,
  resolveSectionArg,
  sectionDir,
} from './lib/journal.ts';
import { isMain } from './lib/is-main.ts';

// Everything below reads the section the CLI/server selected (journal.ts).
const suggestionsPath = (): string => join(sectionDir(currentSection().id), '_topics-suggestions.json');

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
  if (!existsSync(suggestionsPath())) {
    return { schema_version: 1, topics: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(suggestionsPath(), 'utf8'));
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
  mkdirSync(sectionDir(currentSection().id), { recursive: true });
  writeFileSync(suggestionsPath(), JSON.stringify(file, null, 2) + '\n', 'utf8');
}

// Number of most-recent lessons to use as a safety-net candidate set when
// the regex tagger found no topics in the transcript (e.g. a free-form
// conversation lesson with no labelled grammar terms).
const FALLBACK_RECENT_LESSONS = 10;

function loadExistingLessons(filterTopics: readonly TopicT[]): ExistingLessonRef[] {
  let refs: ExistingLessonRef[] = [];
  try {
    refs = readSectionLessons(currentSection().id).map(({ lesson }) => ({
      slug: lesson.slug,
      date: lesson.date,
      title: lesson.title,
      summary: lesson.summary,
      topics: lesson.topics,
    }));
  } catch (err) {
    // A malformed sibling lesson must not block a new extraction; it is
    // reported by build-derived and the server on its own.
    console.warn(`⚠ Could not read all existing lessons: ${(err as Error).message.split('\n')[0]}`);
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

// slug → file name for EVERY lesson of the section, regardless of topic
// overlap. loadExistingLessons() above is filtered to related-candidates;
// slug uniqueness must be checked against the whole catalog.
function loadExistingSlugs(): Map<string, string> {
  return existingSlugs(currentSection().id);
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

  const catalog = readTopicCatalog(currentSection().id);
  const preliminaryTopics = detectTopics(transcript, catalog);
  console.log(`Preliminary topics (regex): ${formatTopics(preliminaryTopics)}`);

  const existingLessons = loadExistingLessons(preliminaryTopics);
  console.log(
    `Extract: ${transcript.length} chars transcript, ${framesManifest.length} slide(s), ${existingLessons.length} candidate lesson(s) in context.`,
  );

  const extractor = getExtractor();
  const vision = await extractor.hasVision();
  if (!vision && framesManifest.length > 0) {
    console.warn(`Extract model (${extractor.driver}) has no vision — skipping ${framesManifest.length} slide(s).`);
  }

  // A text-only model is not told about frames it cannot see: listed by
  // name and timestamp, they were enough for a small model to invent a
  // "slide" out of the transcript.
  const userText = userMessageForLesson({
    transcript,
    dateHint,
    framesManifest: vision ? framesManifest : [],
    existingLessons,
    preliminaryTopics,
  });

  const userParts: ExtractMessagePart[] = [{ type: 'text', text: userText }];
  if (vision) {
    for (const f of framesManifest) {
      const imgPath = join(framesDir, f.file);
      if (!existsSync(imgPath)) {
        console.warn(`Skipping missing frame ${f.file}`);
        continue;
      }
      userParts.push({ type: 'image', imageJpeg: readFileSync(imgPath) });
    }
  }

  const lessonTool = buildLessonTool(catalog);
  console.log(`Extract via ${extractor.driver} (${userParts.filter((p) => p.type === 'image').length} image(s))...`);

  // Double-encoded fields and small-model field drift are repaired before
  // validation; what is still wrong goes back to the model once with the
  // Zod issues (see lib/extract-validate.ts). Every answer is logged.
  const { lesson, toolInput, attempts } = await extractValidated(
    extractor,
    {
      system: buildSystemPrompt(catalog),
      userParts,
      jsonSchema: lessonTool.input_schema,
      toolName: lessonTool.name,
    },
    logsDir,
  );
  if (attempts > 1) console.log(`✓ Lesson valid after a repair round.`);
  const result = { data: lesson };

  const rawSuggestions = toolInput['suggested_new_topics'];
  const suggestedNewTopics: string[] = Array.isArray(rawSuggestions)
    ? rawSuggestions.filter(
        (t: unknown): t is string =>
          typeof t === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t),
      )
    : [];

  // The slug is model-generated. The site routes by slug alone and
  // cheatsheet.json keys processed lessons by slug, so a collision with an
  // existing lesson silently shadows one of them. Re-processing
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
  // Filter out ids already in the catalogue — AI shouldn't suggest
  // those but be defensive so the suggestions file stays meaningful.
  const vocabSet = new Set<string>(catalog.topics.map((t) => t.id));
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
  const positional = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--section');
  const [workDir, dateHint] = positional;
  if (!workDir || !dateHint) {
    console.error('Usage: tsx scripts/extract.ts <work_dir> <YYYY-MM-DD> [--section id]');
    process.exit(1);
  }
  resolveSectionArg(process.argv);
  await extract(workDir, dateHint);
}

if (isMain(import.meta.url)) {
  cli().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
