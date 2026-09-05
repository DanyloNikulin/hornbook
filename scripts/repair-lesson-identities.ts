#!/usr/bin/env node
import { JournalRepository, defaultJournalDir } from './lib/journal.ts';
import { repairLessonIdentities } from './lib/identity-repair.ts';

const journal = new JournalRepository(defaultJournalDir());
const args = process.argv.slice(2);
const id = args[args.indexOf('--section') + 1];
if (!args.includes('--section') || !id)
  throw new Error('Pass --section <id>; HORNBOOK_JOURNAL selects the journal');
console.log(`Repaired ${repairLessonIdentities(journal, id)} lessons in ${id}.`);
