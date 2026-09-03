#!/usr/bin/env node
// One-shot migration from the v1 layout to the journal folder:
//
//   lessons/*.json, lessons/*.md      → journal/<target>-<learner>/
//   cheatsheet.json                   → journal/<section>/_cheatsheet.json
//   lessons/_topics-*.json            → journal/<section>/
//   journal.config.json (root, pair)  → journal/journal.config.json (sections)
//
// Idempotent: a repo already on the new layout is left alone. Nothing is
// deleted until the copy succeeded. `--dry-run` prints the plan only.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeJournalConfig, sectionIdFor } from '../src/lib/journal-config.ts';
import { configPath, journalDir, repoRootDir, saveJournalConfig, sectionDir, writeDerived } from './lib/journal.ts';

const dry = process.argv.includes('--dry-run');
const root = repoRootDir();
const oldConfigPath = join(root, 'journal.config.json');
const oldLessonsDir = join(root, 'lessons');
const oldCheatsheet = join(root, 'cheatsheet.json');

function log(msg: string): void {
  console.log(`${dry ? '[dry-run] ' : ''}${msg}`);
}

if (existsSync(configPath())) {
  console.log(`Journal already exists at ${journalDir()} — nothing to migrate.`);
  process.exit(0);
}
if (!existsSync(oldConfigPath)) {
  console.error(`No ${oldConfigPath} to migrate from. Create a section in the app instead.`);
  process.exit(1);
}

const config = normalizeJournalConfig(JSON.parse(readFileSync(oldConfigPath, 'utf8')));
if (config.sections.length === 0) {
  console.error('Old config has neither `pair` nor `sections` — nothing to migrate.');
  process.exit(1);
}
const section = config.sections[0];
const target = sectionDir(section.id);
log(`Section "${section.id}" (${section.target} → ${section.learner}) → ${target}`);

if (!dry) mkdirSync(target, { recursive: true });

if (existsSync(oldLessonsDir)) {
  for (const f of readdirSync(oldLessonsDir)) {
    // Regenerated files are not worth carrying over.
    if (['_vocab.json', '_cards.json', '_search-index.json'].includes(f)) {
      log(`skip ${f} (derived, regenerated)`);
      if (!dry) rmSync(join(oldLessonsDir, f), { force: true });
      continue;
    }
    log(`move lessons/${f} → journal/${section.id}/${f}`);
    if (!dry) renameSync(join(oldLessonsDir, f), join(target, f));
  }
  if (!dry && readdirSync(oldLessonsDir).length === 0) rmSync(oldLessonsDir, { recursive: true });
}

if (existsSync(oldCheatsheet)) {
  log(`move cheatsheet.json → journal/${section.id}/_cheatsheet.json`);
  if (!dry) renameSync(oldCheatsheet, join(target, '_cheatsheet.json'));
}

log(`write journal/journal.config.json with ${config.sections.length} section(s)`);
if (!dry) {
  saveJournalConfig(config);
  rmSync(oldConfigPath, { force: true });
  writeDerived(section.id);
  console.log(`✓ Migrated. Sections: ${config.sections.map((s) => s.id).join(', ')}`);
  console.log(`  Old root journal.config.json removed; ${sectionIdFor(section.target, section.learner)} is the default section.`);
  const oldData = join(root, 'src', 'app', '_data');
  if (existsSync(oldData)) {
    rmSync(oldData, { recursive: true, force: true });
    console.log('  Removed src/app/_data (no longer generated).');
  }
  writeFileSync(join(journalDir(), '.gitkeep'), '', 'utf8');
}
