#!/usr/bin/env node
// One-shot script to populate the `topics` field on already-committed lessons.
// Runs the regex tagger from scripts/lib/topics.ts over each lesson's combined
// text content (title + summary + article_md + grammar rules + slide text) and
// writes the detected topics back into the lesson JSON.
//
// Idempotent: running again gives the same result.
// Unlike the live extract pipeline, this version does NOT call any AI — it
// uses only the regex tagger. That keeps the backfill free and offline. Run
// once after introducing topics or any time you change scripts/lib/topics.ts
// and want to refresh existing files.
//
// Modes:
//   tsx scripts/backfill-topics.ts                 # default: union (additive,
//                                                  # preserves AI curation)
//   tsx scripts/backfill-topics.ts --dry-run       # show diffs only, no writes
//   tsx scripts/backfill-topics.ts --only-empty    # only touch lessons with []
//   tsx scripts/backfill-topics.ts --rebuild       # destructive: overwrite ALL
//                                                  # topics with regex output
//   tsx scripts/backfill-topics.ts --auto          # hash-aware (build hook mode)
//
// --auto compares the current topics-tagger hash (TOPIC_VOCAB + topics.ts
// source) against lessons/_topics-version.json. If unchanged, behaves like
// --only-empty (safe, fills only missing topics). If changed, runs in UNION
// mode — additive: adds regex-detected topics that aren't already present,
// never removes. Preserves AI curation across regex evolution.
//
// --rebuild is the explicit destructive flag for the rare "start over" case
// (e.g. wholesale topic taxonomy redesign). Use --auto for normal regex
// tweaks so AI-curated topics survive.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lesson, type TopicT } from '../src/lib/schema.ts';
import { detectTopics, formatTopics } from './lib/topics.ts';
import { computeTopicsHash } from './lib/topics-hash.ts';
import { lessonToMarkdown } from './lib/markdown.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lessonsDir = join(repoRoot, 'lessons');
const VERSION_PATH = join(lessonsDir, '_topics-version.json');

const dryRun = process.argv.includes('--dry-run');
const autoMode = process.argv.includes('--auto');
// In --auto, "only-empty" gets enabled dynamically based on hash comparison.
// Bare --only-empty (no --auto) is an explicit user request — honored as-is.
let onlyEmpty = process.argv.includes('--only-empty');
// Destructive replace. Explicit user request to nuke AI curation and re-derive
// from regex; --auto on hash change used to behave this way but now defaults
// to additive union mode instead.
const rebuildMode = process.argv.includes('--rebuild');

interface TopicsVersion {
  hash: string;
  updated_at: string;
}

function readStoredHash(): string | null {
  if (!existsSync(VERSION_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(VERSION_PATH, 'utf8')) as Partial<TopicsVersion>;
    return typeof data.hash === 'string' ? data.hash : null;
  } catch {
    return null;
  }
}

function writeStoredHash(hash: string): void {
  const payload: TopicsVersion = { hash, updated_at: new Date().toISOString() };
  writeFileSync(VERSION_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

// Auto mode: compute current hash, compare to stored, decide which pass to
// run. Hash same → only-empty (safe). Hash changed → UNION mode (additive,
// preserves AI curation). Hash is updated at end if hash changed OR if no
// stored hash existed.
//
// Pre-fix, hash change fell through to destructive overwrite-all, which
// silently wiped AI-curated topics whenever someone tweaked the regex.
// --rebuild is the explicit opt-in for that destructive behavior.
let currentHash: string | null = null;
let hashChanged = false;
if (autoMode) {
  currentHash = computeTopicsHash();
  const storedHash = readStoredHash();
  if (storedHash === currentHash) {
    onlyEmpty = true;
    console.log(`Topics hash unchanged (${currentHash}). Mode: only-empty.`);
  } else {
    hashChanged = true;
    console.log(
      `Topics hash changed: ${storedHash ?? '(first run)'} → ${currentHash}. Mode: union (additive, preserves AI curation).`,
    );
  }
}

if (rebuildMode) {
  console.log('Mode: rebuild (destructive — overwriting all topics with regex output).');
}

// Skip files starting with _ (e.g. _topics-version.json — not a lesson).
const files = readdirSync(lessonsDir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort();

const modeNote = [
  dryRun ? '(dry run)' : '',
  onlyEmpty ? '(only-empty: skip lessons that already have topics)' : '',
]
  .filter(Boolean)
  .join(' ');

console.log(`Scanning ${files.length} lesson(s)... ${modeNote}\n`);

let updated = 0;
let unchanged = 0;
let skipped = 0;

for (const f of files) {
  const path = join(lessonsDir, f);
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`✘ ${f}: parse error: ${(e as Error).message}`);
    skipped++;
    continue;
  }
  const result = Lesson.safeParse(parsed);
  if (!result.success) {
    console.error(`✘ ${f}: invalid schema, skipping`);
    skipped++;
    continue;
  }
  const lesson = result.data;

  // --only-empty: skip lessons that already have topics. This is the safe
  // mode used by build hooks — it can't overwrite AI-curated lists.
  if (onlyEmpty && lesson.topics.length > 0) {
    skipped++;
    continue;
  }

  // Build a single text blob from all human-authored fields. Quote text and
  // vocab examples are skipped — they're often single sentences that match
  // too easily on common Italian words and noise the regex.
  const text = [
    lesson.title,
    lesson.summary,
    lesson.article_md,
    ...lesson.grammar.map((g) => g.rule),
    ...lesson.grammar.flatMap((g) => g.examples),
    ...lesson.slides.map((s) => s.text_md),
  ].join('\n');

  const detected = detectTopics(text);
  const existing = lesson.topics;

  // Mode-aware merge:
  //   --rebuild / explicit --only-empty (empty lesson): destructive replace
  //     with regex output. --only-empty only reaches this branch when
  //     existing is [], so there's nothing to clobber.
  //   default + --auto on hash change: UNION — keep all existing topics
  //     (preserves AI curation), append any newly-detected topics that
  //     aren't already present. Order: existing first (preserves historical
  //     order), then new detections in detection order.
  let nextTopics: TopicT[];
  if (rebuildMode || existing.length === 0) {
    nextTopics = detected;
  } else {
    const existingSet = new Set<TopicT>(existing);
    const additions = detected.filter((t) => !existingSet.has(t));
    nextTopics = [...existing, ...additions];
  }

  const same =
    nextTopics.length === existing.length &&
    nextTopics.every((t, i) => existing[i] === t);

  if (same) {
    console.log(`= ${lesson.slug}`);
    console.log(`    ${formatTopics(existing)}`);
    unchanged++;
    continue;
  }

  console.log(`+ ${lesson.slug}`);
  console.log(`    was: ${formatTopics(existing)}`);
  console.log(`    now: ${formatTopics(nextTopics)}`);
  updated++;

  if (!dryRun) {
    lesson.topics = nextTopics;
    // Re-serialize the full lesson (preserves order via schema, keeps the
    // file readable). Companion .md gets rebuilt too — its content doesn't
    // include topics today, but lessonToMarkdown stays the canonical
    // formatter, so re-emit for consistency.
    writeFileSync(path, JSON.stringify(lesson, null, 2), 'utf8');
    const mdPath = path.replace(/\.json$/, '.md');
    writeFileSync(mdPath, lessonToMarkdown(lesson), 'utf8');
  }
}

console.log(
  `\n${dryRun ? '(dry-run) ' : ''}Updated ${updated}, unchanged ${unchanged}, skipped ${skipped}.`,
);

if (dryRun && updated > 0) {
  console.log('\nRun without --dry-run to write changes.');
}

// In --auto mode: persist the current hash so next prebuild compares against
// today's regex config. Only write if hash genuinely changed (or no stored
// hash existed) — keeps the file clean of churn when builds are no-op.
if (autoMode && hashChanged && currentHash && !dryRun) {
  writeStoredHash(currentHash);
  console.log(`Wrote ${VERSION_PATH.replace(repoRoot, '.')}: ${currentHash}`);
}
