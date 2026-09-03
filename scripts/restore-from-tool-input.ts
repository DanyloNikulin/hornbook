#!/usr/bin/env node
// Restore a committed lesson from a process-lesson workflow artifact's
// tool-input.json. Useful when the workflow generated a valid lesson but
// the final commit-and-push step failed (e.g. dirty package-lock.json).
//
// Usage:
//   gh run download <run-id> --name pipeline-logs-<stem> --dir /tmp/restore
//   tsx scripts/restore-from-tool-input.ts /tmp/restore/logs/tool-input.json

import { readFileSync } from 'node:fs';
import { Lesson } from '../src/lib/schema.ts';
import { resolveSectionArg } from './lib/journal.ts';
import { writeLesson } from './process.ts';

const inputPath = process.argv.slice(2).find((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--section');
if (!inputPath) {
  console.error('Usage: tsx scripts/restore-from-tool-input.ts <path-to-tool-input.json> [--section id]');
  process.exit(1);
}
const section = resolveSectionArg(process.argv);

const raw = readFileSync(inputPath, 'utf8');
const parsed = Lesson.safeParse(JSON.parse(raw));
if (!parsed.success) {
  console.error('✘ tool-input.json failed Zod validation:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

const lesson = parsed.data;
const stem = `${lesson.date}-${lesson.slug}`;
if (lesson.id !== stem) {
  console.log(`Adjusting id ${lesson.id} -> ${stem}`);
  lesson.id = stem;
}

const { jsonPath, mdPath } = writeLesson(section.id, lesson);

console.log(`✓ ${jsonPath}`);
console.log(`✓ ${mdPath}`);
