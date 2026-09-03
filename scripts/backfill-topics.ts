#!/usr/bin/env node
// Populate the `topics` field on lessons that have none, using the regex
// tagger from scripts/lib/topics.ts over each lesson's text (title + summary
// + article_md + grammar + slide text). No AI, free, offline. Runs over every
// section of the journal unless --section limits it.
//
// Modes:
//   tsx scripts/backfill-topics.ts                 # default: union (additive,
//                                                  # preserves AI curation)
//   tsx scripts/backfill-topics.ts --dry-run       # show diffs only, no writes
//   tsx scripts/backfill-topics.ts --only-empty    # only touch lessons with []
//   tsx scripts/backfill-topics.ts --rebuild       # destructive: overwrite ALL
//                                                  # topics with regex output
//   tsx scripts/backfill-topics.ts --auto          # hash-aware (build hook mode)
//   tsx scripts/backfill-topics.ts --section es-en # one section only
//
// --auto compares the current topics-tagger hash (TOPIC_VOCAB + topics.ts
// source) against <section>/_topics-version.json. If unchanged, behaves like
// --only-empty (safe, fills only missing topics). If changed, runs in UNION
// mode — additive: adds regex-detected topics that aren't already present,
// never removes. Preserves AI curation across regex evolution.
//
// --rebuild is the explicit destructive flag for the rare "start over" case
// (wholesale topic taxonomy redesign). Use --auto for normal regex tweaks so
// AI-curated topics survive.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lesson, type TopicT } from '../src/lib/schema.ts';
import { detectTopics, formatTopics } from './lib/topics.ts';
import { computeTopicsHash } from './lib/topics-hash.ts';
import { lessonToMarkdown } from './lib/markdown.ts';
import { configPath, journalDir, lessonFiles, listSections, sectionDir } from './lib/journal.ts';

const dryRun = process.argv.includes('--dry-run');
const autoMode = process.argv.includes('--auto');
const explicitOnlyEmpty = process.argv.includes('--only-empty');
const rebuildMode = process.argv.includes('--rebuild');
const sectionIdx = process.argv.indexOf('--section');
const onlySection = sectionIdx >= 0 ? process.argv[sectionIdx + 1] : null;

interface TopicsVersion {
  hash: string;
  updated_at: string;
}

function readStoredHash(versionPath: string): string | null {
  if (!existsSync(versionPath)) return null;
  try {
    const data = JSON.parse(readFileSync(versionPath, 'utf8')) as Partial<TopicsVersion>;
    return typeof data.hash === 'string' ? data.hash : null;
  } catch {
    return null;
  }
}

function writeStoredHash(versionPath: string, hash: string): void {
  const payload: TopicsVersion = { hash, updated_at: new Date().toISOString() };
  writeFileSync(versionPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

if (!existsSync(configPath())) {
  console.log(`No journal at ${journalDir()} — nothing to backfill.`);
  process.exit(0);
}

const sections = listSections().filter((s) => !onlySection || s.id === onlySection);
if (onlySection && sections.length === 0) {
  console.error(`✘ Unknown section "${onlySection}".`);
  process.exit(1);
}
if (rebuildMode) {
  console.log('Mode: rebuild (destructive — overwriting all topics with regex output).');
}

const currentHash = autoMode ? computeTopicsHash() : null;
let totalUpdated = 0;

for (const section of sections) {
  const dir = sectionDir(section.id);
  const versionPath = join(dir, '_topics-version.json');

  // Auto mode: hash same → only-empty (safe). Hash changed → UNION mode
  // (additive, preserves AI curation). The stored hash is updated at the end
  // when it changed or none existed.
  let onlyEmpty = explicitOnlyEmpty;
  let hashChanged = false;
  if (autoMode && currentHash) {
    const storedHash = readStoredHash(versionPath);
    if (storedHash === currentHash) {
      onlyEmpty = true;
    } else {
      hashChanged = true;
      console.log(
        `[${section.id}] Topics hash changed: ${storedHash ?? '(first run)'} → ${currentHash}. Mode: union.`,
      );
    }
  }

  const files = lessonFiles(section.id);
  const modeNote = [
    dryRun ? '(dry run)' : '',
    onlyEmpty ? '(only-empty)' : '',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`[${section.id}] Scanning ${files.length} lesson(s)... ${modeNote}`);

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const f of files) {
    const path = join(dir, f);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      console.error(`✘ ${section.id}/${f}: parse error: ${(e as Error).message}`);
      skipped++;
      continue;
    }
    const result = Lesson.safeParse(parsed);
    if (!result.success) {
      console.error(`✘ ${section.id}/${f}: invalid schema, skipping`);
      skipped++;
      continue;
    }
    const lesson = result.data;

    if (onlyEmpty && lesson.topics.length > 0) {
      skipped++;
      continue;
    }

    // Quote text and vocab examples are skipped — single sentences match too
    // easily on common words and noise the regex.
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

    let nextTopics: TopicT[];
    if (rebuildMode || existing.length === 0) {
      nextTopics = detected;
    } else {
      const existingSet = new Set<TopicT>(existing);
      nextTopics = [...existing, ...detected.filter((t) => !existingSet.has(t))];
    }

    const same = nextTopics.length === existing.length && nextTopics.every((t, i) => existing[i] === t);
    if (same) {
      unchanged++;
      continue;
    }

    console.log(`+ ${section.id}/${lesson.slug}`);
    console.log(`    was: ${formatTopics(existing)}`);
    console.log(`    now: ${formatTopics(nextTopics)}`);
    updated++;

    if (!dryRun) {
      lesson.topics = nextTopics;
      writeFileSync(path, JSON.stringify(lesson, null, 2) + '\n', 'utf8');
      writeFileSync(path.replace(/\.json$/, '.md'), lessonToMarkdown(lesson), 'utf8');
    }
  }

  console.log(`[${section.id}] ${dryRun ? '(dry-run) ' : ''}updated ${updated}, unchanged ${unchanged}, skipped ${skipped}.`);
  totalUpdated += updated;

  if (autoMode && currentHash && hashChanged && !dryRun) {
    writeStoredHash(versionPath, currentHash);
    console.log(`[${section.id}] wrote _topics-version.json: ${currentHash}`);
  }
}

if (dryRun && totalUpdated > 0) {
  console.log('\nRun without --dry-run to write changes.');
}
