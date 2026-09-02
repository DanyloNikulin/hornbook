#!/usr/bin/env node
// Restore a committed lesson from a process-lesson workflow artifact's
// tool-input.json. Useful when the workflow generated a valid lesson but
// the final commit-and-push step failed (e.g. dirty package-lock.json).
//
// Usage:
//   gh run download <run-id> --name pipeline-logs-<stem> --dir /tmp/restore
//   tsx scripts/restore-from-tool-input.ts /tmp/restore/logs/tool-input.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lesson } from '../src/lib/schema.ts';
import { lessonToMarkdown } from './lib/markdown.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lessonsDir = join(repoRoot, 'lessons');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: tsx scripts/restore-from-tool-input.ts <path-to-tool-input.json>');
  process.exit(1);
}

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

mkdirSync(lessonsDir, { recursive: true });
const jsonPath = join(lessonsDir, `${stem}.json`);
const mdPath = join(lessonsDir, `${stem}.md`);

writeFileSync(jsonPath, JSON.stringify(lesson, null, 2), 'utf8');
writeFileSync(mdPath, lessonToMarkdown(lesson), 'utf8');

console.log(`✓ ${jsonPath}`);
console.log(`✓ ${mdPath}`);
