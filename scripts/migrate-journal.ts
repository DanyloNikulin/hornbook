#!/usr/bin/env node
import { defaultJournalDir, repoRootDir } from './lib/journal.ts';
import { migrateLegacyJournal } from './lib/legacy-migration.ts';

const dry = process.argv.includes('--dry-run');
const files = migrateLegacyJournal(repoRootDir(), defaultJournalDir(), dry);
console.log(
  files.length
    ? `${dry ? 'Would migrate' : 'Migrated'} ${files.length} files. Legacy source files are preserved for archival.`
    : 'Journal already exists; nothing to migrate.',
);
