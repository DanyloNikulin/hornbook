#!/usr/bin/env node
// Scaffold a valid empty lesson JSON in a section. $0, no APIs.
//
//   tsx scripts/lesson-new.ts --date 2026-09-02 --title "Greetings" [--section es-en]

import { Lesson } from '../src/lib/schema.ts';
import { slugify, ensureUniqueSlug } from './lib/slug.ts';
import { existingSlugs, resolveSectionArg } from './lib/cli-journal.ts';
import { writeLesson } from './process.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const date = arg('date');
const title = arg('title') ?? 'New lesson';
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: tsx scripts/lesson-new.ts --date YYYY-MM-DD [--title "Greetings"] [--section id]');
  process.exit(1);
}

const section = resolveSectionArg(process.argv);
const slug = ensureUniqueSlug(slugify(title) || 'lesson', date, existingSlugs(section.id));
const lesson = Lesson.parse({
  id: `${date}-${slug}`,
  date,
  slug,
  title,
  summary: 'Write a 2–3 sentence summary in the learner language.',
  article_md: '## Takeaway\n\nWhat should the student remember?\n\n## Rules\n\n- ',
});

const out = writeLesson(section.id, lesson);
console.log(`✓ ${out.jsonPath}`);
console.log('Fill it in, then open the app — the section picks it up on save or restart.');
