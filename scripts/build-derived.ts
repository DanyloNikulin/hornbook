#!/usr/bin/env node
// Pre-build step: read /lessons/*.json and produce four derived artifacts
// for the Angular app to consume. After issue #19 (lazy-load architecture)
// most lesson content is shipped as static assets at runtime; only a tiny
// metadata manifest stays bundled.
//
//   src/app/_data/lessons-meta.json — compact lesson metadata, sorted newest
//                                     first. Bundled into the initial JS chunk
//                                     to power the home page + sync APIs in
//                                     LessonsService (neighbors, indexBySlug,
//                                     pickRandomMeta, topic filter).
//
//   lessons/_search-index.json     — flat array of {lesson_slug, lesson_title,
//                                     lesson_date, section, ts?, text} docs.
//                                     Lazy-fetched by SearchService on first
//                                     /search visit, fed into a single Fuse
//                                     index.
//
//   lessons/_vocab.json            — global vocabulary deduplicated across
//                                     lessons, with first_seen + seen_in
//                                     metadata. Lazy-fetched by VocabService.
//
//   lessons/_cards.json            — complete deduplicated flashcard pool.
//                                     Lazy-fetched in one request by the
//                                     unfiltered /flashcards screen.
//
// Each per-lesson JSON in /lessons/<slug>.json is the source of truth and is
// served as a static asset via angular.json's `assets` glob — no copying.
//
// The root /cheatsheet.json is also served as a static asset by the assets
// glob; nothing here writes a duplicate.
//
// Lessons are validated against the shared Zod schema from src/lib/schema.ts.
// Build fails loudly if any lesson is malformed.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Lesson,
  Cheatsheet,
  type DerivedCardT,
  type DerivedVocabT,
  type LessonT,
  type LessonMetaT,
} from '../src/lib/schema.ts';
import { deriveExpectedFromBack } from '../src/lib/card-text.ts';
import { cardId } from '../src/lib/sm2.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lessonsDir = join(repoRoot, 'lessons');
const dataDir = join(repoRoot, 'src', 'app', '_data');

mkdirSync(dataDir, { recursive: true });

const metaOut = join(dataDir, 'lessons-meta.json');
const vocabOut = join(lessonsDir, '_vocab.json');
const cardsOut = join(lessonsDir, '_cards.json');
const searchIndexOut = join(lessonsDir, '_search-index.json');

if (!existsSync(lessonsDir)) {
  // Make sure even an empty repo has the bundled manifest the SPA expects.
  writeFileSync(metaOut, '[]', 'utf8');
  console.log('No lessons/ directory — wrote empty manifest.');
  process.exit(0);
}

mkdirSync(lessonsDir, { recursive: true });

// Skip files starting with _ (e.g. _topics-version.json — metadata, not a
// lesson; _vocab.json + _cards.json + _search-index.json — emitted here).
const files = readdirSync(lessonsDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

let hasErrors = false;
const lessons: LessonT[] = files.flatMap((f) => {
  const raw = readFileSync(join(lessonsDir, f), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`✘ ${f}: parse error: ${(err as Error).message}`);
    hasErrors = true;
    return [];
  }
  const result = Lesson.safeParse(parsed);
  if (!result.success) {
    console.error(`✘ ${f}: failed schema validation`);
    console.error(JSON.stringify(result.error.format(), null, 2));
    hasErrors = true;
    return [];
  }
  return [result.data];
});

if (hasErrors) {
  throw new Error('Some lessons failed validation — see errors above.');
}

// Slugs must be unique: the SPA routes /lesson/:slug, the manifest lookup
// takes the first match, and cheatsheet.json keys processed lessons by slug
// (issue #65). extract.ts guards newly generated lessons; this catches hand
// edits and anything that slipped through before the guard existed.
const filesBySlug = new Map<string, string[]>();
lessons.forEach((l, i) => {
  filesBySlug.set(l.slug, [...(filesBySlug.get(l.slug) ?? []), files[i] ?? '?']);
});
const duplicateSlugs = [...filesBySlug].filter(([, fs]) => fs.length > 1);
if (duplicateSlugs.length > 0) {
  for (const [slug, fs] of duplicateSlugs) {
    console.error(`✘ duplicate slug "${slug}": ${fs.join(', ')}`);
  }
  throw new Error('Duplicate lesson slugs — give one of each pair a distinct slug (slug + id + file name).');
}

// Sort ASC for vocab derivation (so first_seen = earliest lesson),
// DESC for the metadata manifest the UI consumes.
const lessonsAsc = [...lessons].sort((a, b) => (a.date < b.date ? -1 : 1));
const lessonsDesc = [...lessons].sort((a, b) => (a.date < b.date ? 1 : -1));

// ── 1. Compact metadata manifest (bundled) ────────────────────────────────
const metas: LessonMetaT[] = lessonsDesc.map((l) => ({
  slug: l.slug,
  date: l.date,
  title: l.title,
  summary: l.summary,
  duration_min: l.duration_min,
  topics: l.topics,
  vocabCount: l.vocabulary.length,
  grammarCount: l.grammar.length,
  slidesCount: l.slides.length,
  quizCount: l.quiz.length,
}));
writeFileSync(metaOut, JSON.stringify(metas, null, 2), 'utf8');
console.log(`✓ ${metas.length} lesson meta(s) -> src/app/_data/lessons-meta.json`);

// ── 2. Deduplicated vocab (static asset) ──────────────────────────────────
const vocabByKey = new Map<string, DerivedVocabT>();
for (const lesson of lessonsAsc) {
  const seenInThisLesson = new Set<string>();
  for (const v of lesson.vocabulary ?? []) {
    const key = String(v.target).trim().toLowerCase();
    if (!key) continue;
    if (seenInThisLesson.has(key)) continue;
    seenInThisLesson.add(key);

    const existing = vocabByKey.get(key);
    if (!existing) {
      vocabByKey.set(key, {
        target: v.target,
        learner: v.learner,
        level: v.level ?? null,
        example_target: v.example_target,
        example_learner: v.example_learner,
        first_seen: lesson.slug,
        first_seen_date: lesson.date,
        seen_in: [lesson.slug],
      });
    } else {
      existing.seen_in.push(lesson.slug);
    }
  }
}
// Alphabetize by the noun, not the article: "i genitori" files under G,
// "la famiglia" under F — otherwise ~⅓ of entries clump under i/l/u. The
// stored `it` (article included) is what gets displayed; this only affects
// sort order. Falls back to the full string if stripping would empty it.
const LEADING_ARTICLE = /^(?:l['’]\s*|un['’]\s*|(?:gli|uno|una|il|lo|la|le|un|i)\s+)/i;
const sortKey = (s: string): string => {
  const stripped = s.replace(LEADING_ARTICLE, '').trim();
  return (stripped || s).toLocaleLowerCase('it');
};
const vocab = [...vocabByKey.values()].sort((a, b) =>
  sortKey(a.target).localeCompare(sortKey(b.target), 'en'),
);
writeFileSync(vocabOut, JSON.stringify(vocab, null, 2), 'utf8');
console.log(`✓ ${vocab.length} unique vocab item(s) -> lessons/_vocab.json`);

// ── 3. Pre-built global flashcards (static asset) ─────────────────────────
// Preserve the old runtime ordering: newest lesson first, vocabulary in the
// global alphabetical order inside each lesson, then that lesson's AI cards.
// Untouched cards use pool order as their stable tie-breaker, so this avoids
// unexpectedly reshuffling an existing learner's next-card sequence.
const cardsById = new Map<string, DerivedCardT>();

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function mergeCard(card: DerivedCardT): void {
  const existing = cardsById.get(card.id);
  if (!existing) {
    cardsById.set(card.id, card);
    return;
  }
  cardsById.set(card.id, {
    ...existing,
    source: existing.source === 'ai' || card.source === 'ai' ? 'ai' : existing.source,
    tags: dedupe([...existing.tags, ...card.tags]),
    lessons: dedupe([...existing.lessons, ...card.lessons]),
  });
}

for (const lesson of lessonsDesc) {
  for (const v of vocab) {
    if (!v.seen_in.includes(lesson.slug)) continue;
    const tags = v.level ? [v.level] : [];

    const forwardBack = v.example_target ? `${v.learner}\n\n${v.example_target}` : v.learner;
    mergeCard({
      id: cardId(v.target, forwardBack),
      front: v.target,
      back: forwardBack,
      direction: 'target-learner',
      source: 'vocab',
      type: 'word',
      tags,
      lessons: dedupe(v.seen_in),
      expected: v.learner,
    });

    const reverseBack = v.example_target ? `${v.target}\n\n${v.example_target}` : v.target;
    mergeCard({
      id: cardId(v.learner, reverseBack),
      front: v.learner,
      back: reverseBack,
      direction: 'learner-target',
      source: 'vocab',
      type: 'word',
      tags,
      lessons: dedupe(v.seen_in),
      expected: v.target,
    });
  }

  for (const flashcard of lesson.flashcards) {
    mergeCard({
      id: cardId(flashcard.front, flashcard.back),
      front: flashcard.front,
      back: flashcard.back,
      direction: 'target-learner',
      source: 'ai',
      type: flashcard.type,
      tags: flashcard.tags,
      lessons: [lesson.slug],
      expected: deriveExpectedFromBack(flashcard.back),
    });
  }
}

const cards = [...cardsById.values()];
writeFileSync(cardsOut, JSON.stringify(cards), 'utf8');
console.log(`✓ ${cards.length} flashcard(s) -> lessons/_cards.json`);

// ── 4. Search index (static asset) ────────────────────────────────────────
// One flat document per section per lesson. Mirrors what SearchService used to
// build at runtime from full lesson content — pre-baking it here keeps the
// initial JS chunk free of all that prose.
interface SearchDoc {
  lesson_slug: string;
  lesson_title: string;
  lesson_date: string;
  section: 'article' | 'vocab' | 'grammar' | 'quote' | 'slide';
  text: string;
  ts?: string;
}

const searchDocs: SearchDoc[] = [];
for (const l of lessonsDesc) {
  searchDocs.push({
    lesson_slug: l.slug,
    lesson_title: l.title,
    lesson_date: l.date,
    section: 'article',
    text: l.article_md,
  });
  for (const v of l.vocabulary) {
    const ex = [v.example_target, v.example_learner].filter(Boolean).join(' — ');
    searchDocs.push({
      lesson_slug: l.slug,
      lesson_title: l.title,
      lesson_date: l.date,
      section: 'vocab',
      text: [v.target, v.learner, ex].filter(Boolean).join(' · '),
    });
  }
  for (const g of l.grammar) {
    searchDocs.push({
      lesson_slug: l.slug,
      lesson_title: l.title,
      lesson_date: l.date,
      section: 'grammar',
      text: [g.rule, ...g.examples].join(' · '),
    });
  }
  for (const q of l.quotes) {
    searchDocs.push({
      lesson_slug: l.slug,
      lesson_title: l.title,
      lesson_date: l.date,
      section: 'quote',
      ts: q.ts,
      text: q.gloss ? `${q.text} — ${q.gloss}` : q.text,
    });
  }
  for (const s of l.slides) {
    searchDocs.push({
      lesson_slug: l.slug,
      lesson_title: l.title,
      lesson_date: l.date,
      section: 'slide',
      ts: s.ts,
      text: s.text_md,
    });
  }
}
writeFileSync(searchIndexOut, JSON.stringify(searchDocs), 'utf8');
console.log(`✓ ${searchDocs.length} search doc(s) -> lessons/_search-index.json`);

// ── 5. Cheatsheet validation ──────────────────────────────────────────────
// The angular assets glob ships /cheatsheet.json straight from the repo root,
// so we don't write a copy. We do parse it once to surface schema errors
// during build instead of at runtime.
const cheatsheetSrc = join(repoRoot, 'cheatsheet.json');
if (existsSync(cheatsheetSrc)) {
  const raw = JSON.parse(readFileSync(cheatsheetSrc, 'utf8'));
  const result = Cheatsheet.safeParse(raw);
  if (result.success) {
    const total = result.data.categories.reduce((n, c) => n + c.sections.length, 0);
    console.log(`✓ cheatsheet.json validated (${total} sections)`);
  } else {
    console.warn('⚠ cheatsheet.json failed validation — ship may be broken:');
    console.warn(JSON.stringify(result.error.format(), null, 2));
  }
} else {
  console.log('✓ cheatsheet.json not found — skipping validation');
}
