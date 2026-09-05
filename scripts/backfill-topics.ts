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
// --auto compares the section's tagger hash (topic ids and patterns in its
// _topics.json) against <section>/_topics-version.json. If unchanged, behaves like
// --only-empty (safe, fills only missing topics). If changed, runs in UNION
// mode — additive: adds regex-detected topics that aren't already present,
// never removes. Preserves AI curation across regex evolution.
//
// --rebuild is the explicit destructive flag for the rare "start over" case
// (wholesale topic taxonomy redesign). Use --auto for normal regex tweaks so
// AI-curated topics survive.

import { existsSync } from 'node:fs';
import { JournalRepository, defaultJournalDir } from './lib/journal.ts';
import { backfillSection } from './lib/topic-backfill.ts';
import { formatTopics } from './lib/topics.ts';

const dryRun = process.argv.includes('--dry-run');
const auto = process.argv.includes('--auto');
const onlyEmpty = process.argv.includes('--only-empty');
const rebuild = process.argv.includes('--rebuild');
const sectionIndex = process.argv.indexOf('--section');
const onlySection = sectionIndex >= 0 ? process.argv[sectionIndex + 1] : null;
const journal = new JournalRepository(defaultJournalDir());
if (!existsSync(journal.configPath())) {
  console.log('No journal at ' + journal.root + ' — nothing to backfill.');
  process.exit(0);
}
const sections = journal
  .listSections()
  .filter((section) => !onlySection || section.id === onlySection);
if (onlySection && sections.length === 0) {
  console.error('Unknown section: ' + onlySection);
  process.exit(1);
}
if (rebuild) console.log('Mode: rebuild (destructive — overwriting all topics with regex output).');
let totalUpdated = 0;
for (const section of sections) {
  const result = backfillSection(journal, section.id, { dryRun, auto, onlyEmpty, rebuild });
  console.log(
    '[' + section.id + '] Scanned ' + result.total + ' lesson(s)' + (dryRun ? ' (dry-run)' : ''),
  );
  if (result.hashChanged)
    console.log(
      'Topics hash changed: ' + (result.previousHash ?? '(first run)') + ' → ' + result.hash,
    );
  for (const update of result.updates) {
    console.log('+ ' + section.id + '/' + update.slug);
    console.log('    was: ' + formatTopics(update.previous));
    console.log('    now: ' + formatTopics(update.topics));
  }
  console.log(
    'Updated ' +
      result.updates.length +
      ', unchanged ' +
      result.unchanged +
      ', skipped ' +
      result.skipped +
      '.',
  );
  totalUpdated += result.updates.length;
  if (result.hashChanged && !dryRun) console.log('Saved topic version: ' + result.hash);
}
if (dryRun && totalUpdated > 0) console.log('Run without --dry-run to write changes.');
