// Derived data for one section, computed from its validated lessons:
//
//   metas       compact lesson metadata, newest first (home page, sidebar nav,
//               neighbours, topic filter)
//   vocab       global vocabulary deduplicated across lessons with first_seen
//               and seen_in
//   cards       complete deduplicated flashcard pool
//   searchDocs  one flat document per section per lesson for the Fuse index
//
// Pure: no file system. `writeDerived` in journal.ts persists the bundle;
// the server calls this on every lesson save.

import {
  type DerivedCardT,
  type DerivedVocabT,
  type LessonT,
  type LessonMetaT,
} from '../../src/lib/schema.ts';
import { deriveExpectedFromBack } from '../../src/lib/card-text.ts';
import { cardId } from '../../src/lib/sm2.ts';
import { studyCardId } from '../../src/lib/content-ids.ts';
import { articleRegexFor } from '../../src/lib/articles.ts';

export interface SearchDoc {
  lesson_slug: string;
  lesson_title: string;
  lesson_date: string;
  section: 'article' | 'vocab' | 'grammar' | 'quote' | 'slide';
  text: string;
  ts?: string;
}

export interface DerivedBundle {
  metas: LessonMetaT[];
  vocab: DerivedVocabT[];
  cards: DerivedCardT[];
  searchDocs: SearchDoc[];
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Throws on duplicate slugs: routes, manifests and cheat sheets all key by slug. */
export function assertUniqueSlugs(lessons: readonly LessonT[]): void {
  const bySlug = new Map<string, string[]>();
  for (const l of lessons) {
    bySlug.set(l.slug, [...(bySlug.get(l.slug) ?? []), l.id]);
  }
  const dups = [...bySlug].filter(([, ids]) => ids.length > 1);
  if (dups.length > 0) {
    const lines = dups.map(([slug, ids]) => `  "${slug}": ${ids.join(', ')}`);
    throw new Error(`Duplicate lesson slugs:\n${lines.join('\n')}`);
  }
}

export function lessonMeta(l: LessonT): LessonMetaT {
  return {
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
  };
}

export function buildDerived(lessons: readonly LessonT[], targetLang: string): DerivedBundle {
  assertUniqueSlugs(lessons);

  const lessonsAsc = [...lessons].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const lessonsDesc = [...lessons].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  // ── metas ──
  const metas = lessonsDesc.map(lessonMeta);

  // ── vocab ──
  const vocabByKey = new Map<string, DerivedVocabT>();
  for (const lesson of lessonsAsc) {
    const seenInThisLesson = new Set<string>();
    for (const v of lesson.vocabulary) {
      const key = String(v.target).trim().toLowerCase();
      if (!key || seenInThisLesson.has(key)) continue;
      seenInThisLesson.add(key);
      const existing = vocabByKey.get(key);
      if (!existing) {
        vocabByKey.set(key, {
          id: v.id,
          source_ids: [v.id],
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
        existing.source_ids.push(v.id);
      }
    }
  }
  // Alphabetise by the noun, not the article, for targets with an article
  // table ("la famiglia" files under F). Display keeps the article.
  const articleRe = articleRegexFor(targetLang);
  const sortKey = (s: string): string => {
    const stripped = articleRe ? s.replace(articleRe, '').trim() : s;
    return (stripped || s).toLocaleLowerCase(targetLang);
  };
  const vocab = [...vocabByKey.values()].sort((a, b) =>
    sortKey(a.target).localeCompare(sortKey(b.target), targetLang),
  );

  // ── cards ──
  // Newest lesson first, then source order. The canonical ID comes from the
  // first lesson-scoped source, while identical study content stays one card.
  const cardsByContent = new Map<string, DerivedCardT>();
  const mergeCard = (card: DerivedCardT): void => {
    const contentId = card.legacy_id ?? cardId(card.front, card.back);
    const existing = cardsByContent.get(contentId);
    if (!existing) {
      cardsByContent.set(contentId, card);
      return;
    }
    cardsByContent.set(contentId, {
      ...existing,
      source_ids: dedupe([...existing.source_ids, ...card.source_ids]),
      source: existing.source === 'ai' || card.source === 'ai' ? 'ai' : existing.source,
      tags: dedupe([...existing.tags, ...card.tags]),
      lessons: dedupe([...existing.lessons, ...card.lessons]),
    });
  };

  const addedVocab = new Set<string>();
  for (const lesson of lessonsDesc) {
    for (const v of vocab) {
      if (!v.seen_in.includes(lesson.slug) || addedVocab.has(v.id)) continue;
      addedVocab.add(v.id);
      const tags = v.level ? [v.level] : [];
      const forwardBack = v.example_target ? `${v.learner}\n\n${v.example_target}` : v.learner;
      mergeCard({
        id: studyCardId(v.id, 'target-learner'),
        source_ids: v.source_ids.map((id) => studyCardId(id, 'target-learner')),
        legacy_id: cardId(v.target, forwardBack),
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
        id: studyCardId(v.id, 'learner-target'),
        source_ids: v.source_ids.map((id) => studyCardId(id, 'learner-target')),
        legacy_id: cardId(v.learner, reverseBack),
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
        id: studyCardId(flashcard.id, 'target-learner'),
        source_ids: [studyCardId(flashcard.id, 'target-learner')],
        legacy_id: cardId(flashcard.front, flashcard.back),
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
  const cards = [...cardsByContent.values()];

  // ── search docs ──
  const searchDocs: SearchDoc[] = [];
  for (const l of lessonsDesc) {
    const base = { lesson_slug: l.slug, lesson_title: l.title, lesson_date: l.date };
    searchDocs.push({ ...base, section: 'article', text: l.article_md });
    for (const v of l.vocabulary) {
      const ex = [v.example_target, v.example_learner].filter(Boolean).join(' — ');
      searchDocs.push({ ...base, section: 'vocab', text: [v.target, v.learner, ex].filter(Boolean).join(' · ') });
    }
    for (const g of l.grammar) {
      searchDocs.push({ ...base, section: 'grammar', text: [g.rule, ...g.examples].join(' · ') });
    }
    for (const q of l.quotes) {
      searchDocs.push({ ...base, section: 'quote', ts: q.ts, text: q.gloss ? `${q.text} — ${q.gloss}` : q.text });
    }
    for (const s of l.slides) {
      searchDocs.push({ ...base, section: 'slide', ts: s.ts, text: s.text_md });
    }
  }

  return { metas, vocab, cards, searchDocs };
}
