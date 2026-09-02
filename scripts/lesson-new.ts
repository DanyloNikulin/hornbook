#!/usr/bin/env node
// Scaffold a valid empty lesson JSON. $0, no APIs.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lesson } from '../src/lib/schema.ts';
import { slugify, ensureUniqueSlug } from './lib/slug.ts';
import { readdirSync, readFileSync } from 'node:fs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lessonsDir = join(repoRoot, 'lessons');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function existingSlugs(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(lessonsDir)) return out;
  for (const f of readdirSync(lessonsDir).filter((n) => n.endsWith('.json') && !n.startsWith('_'))) {
    try {
      const raw = JSON.parse(readFileSync(join(lessonsDir, f), 'utf8')) as { slug?: string };
      if (typeof raw.slug === 'string') out.set(raw.slug, f);
    } catch {
      /* skip */
    }
  }
  return out;
}

const date = arg('date');
const title = arg('title') ?? 'New lesson';
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: tsx scripts/lesson-new.ts --date YYYY-MM-DD [--title "Greetings"]');
  process.exit(1);
}

const slug = ensureUniqueSlug(slugify(title) || 'lesson', date, existingSlugs());
const lesson = Lesson.parse({
  id: `${date}-${slug}`,
  date,
  slug,
  title,
  summary: 'Write a 2–3 sentence summary in the learner language.',
  article_md: '## Takeaway\n\nWhat should the student remember?\n\n## Rules\n\n- ',
  vocabulary: [],
  grammar: [],
  quotes: [],
  quiz: [],
  flashcards: [],
  slides: [],
  related: [],
  topics: [],
});

mkdirSync(lessonsDir, { recursive: true });
const path = join(lessonsDir, `${lesson.id}.json`);
writeFileSync(path, JSON.stringify(lesson, null, 2) + '\n', 'utf8');
console.log(`✓ ${path}`);
console.log('Fill it in, then npm start. Or use /compose with npm run ingest.');
