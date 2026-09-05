import { z } from 'zod';
import { lessonContentId } from './content-ids.js';

export const Level = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

const DateRegex = /^\d{4}-\d{2}-\d{2}$/;
const SlugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Topics are a per-section vocabulary kept in <section>/_topics.json (the
// TopicCatalog below). A lesson carries slugs from that catalogue; the schema
// checks only the shape so a journal can grow its own list without touching
// the code.
export const Topic = z.string().regex(SlugRegex);

export const Vocab = z.object({
  id: z.string().min(1).optional(),
  target: z.string().min(1),
  learner: z.string().min(1),
  level: Level.nullable().optional(),
  example_target: z.string().optional(),
  example_learner: z.string().optional(),
});

export const DerivedVocab = z.object({
  id: z.string().min(1),
  source_ids: z.array(z.string().min(1)).min(1),
  target: z.string().min(1),
  learner: z.string().min(1),
  level: Level.nullable(),
  example_target: z.string().optional(),
  example_learner: z.string().optional(),
  first_seen: z.string().regex(SlugRegex),
  first_seen_date: z.string().regex(DateRegex),
  seen_in: z.array(z.string().regex(SlugRegex)),
});

export const CardDirection = z.enum(['target-learner', 'learner-target']);

export const DerivedCard = z.object({
  id: z.string().min(1),
  source_ids: z.array(z.string().min(1)).min(1),
  legacy_id: z.string().min(1).optional(),
  front: z.string().min(1),
  back: z.string().min(1),
  direction: CardDirection,
  source: z.enum(['ai', 'vocab']),
  type: z.enum(['word', 'phrase', 'grammar']),
  tags: z.array(z.string()),
  lessons: z.array(z.string().regex(SlugRegex)).min(1),
  expected: z.string().min(1).optional(),
});

export const GrammarRule = z.object({
  rule: z.string().min(1),
  examples: z.array(z.string()).default([]),
  table: z.array(z.array(z.string())).optional(),
});

const TimestampRegex = /^\d{1,2}:\d{2}(:\d{2})?(-\d{1,2}:\d{2}(:\d{2})?)?$/;

export const Quote = z.object({
  speaker: z.enum(['teacher', 'student']),
  text: z.string().min(1),
  gloss: z.string().optional(),
  ts: z.string().regex(TimestampRegex),
});

export const QuizMC = z
  .object({
    type: z.literal('mc'),
    q: z.string().min(1),
    options: z.array(z.string()).min(2).max(6),
    answer: z.number().int().nonnegative(),
    explanation: z.string().optional(),
  })
  .superRefine((question, ctx) => {
    if (question.answer >= question.options.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer'],
        message: `answer index ${question.answer} is outside ${question.options.length} options`,
      });
    }
  });

export const QuizFill = z.object({
  type: z.literal('fill'),
  q: z.string().min(1),
  answer: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  case_sensitive: z.boolean().default(false),
});

export const QuizTranslate = z.object({
  type: z.literal('translate'),
  q: z.string().min(1),
  answer_target: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  auto_check: z.boolean().default(false),
});

export const QuizQuestion = z.discriminatedUnion('type', [QuizMC, QuizFill, QuizTranslate]);

export const Flashcard = z.object({
  id: z.string().min(1).optional(),
  front: z.string().min(1),
  back: z.string().min(1),
  type: z.enum(['word', 'phrase', 'grammar']),
  tags: z.array(z.string()).default([]),
});

export const Slide = z.object({
  ts: z.string().regex(TimestampRegex),
  text_md: z.string(),
  extracted_table: z.array(z.array(z.string())).optional(),
});

export const LessonShape = z.object({
  id: z.string().min(1),
  date: z.string().regex(DateRegex),
  slug: z.string().regex(SlugRegex),
  title: z.string().min(1),
  summary: z.string().min(1),
  article_md: z.string().min(1),
  duration_min: z.number().int().positive().optional(),
  vocabulary: z.array(Vocab).default([]),
  grammar: z.array(GrammarRule).default([]),
  quotes: z.array(Quote).default([]),
  quiz: z.array(QuizQuestion).default([]),
  flashcards: z.array(Flashcard).default([]),
  slides: z.array(Slide).default([]),
  related: z.array(z.string().regex(SlugRegex)).default([]),
  topics: z.array(Topic).default([]),
});

export const Lesson = LessonShape.transform((lesson) => {
  const id = `${lesson.date}-${lesson.slug}`;
  return {
    ...lesson,
    id,
    vocabulary: lesson.vocabulary.map((entry, index) => ({
      ...entry,
      id: lessonContentId(id, 'vocab', index),
    })),
    flashcards: lesson.flashcards.map((entry, index) => ({
      ...entry,
      id: lessonContentId(id, 'card', index),
    })),
  };
});

export const LessonMeta = z.object({
  slug: z.string().regex(SlugRegex),
  date: z.string().regex(DateRegex),
  title: z.string().min(1),
  summary: z.string().min(1),
  duration_min: z.number().int().positive().optional(),
  topics: z.array(Topic).default([]),
  vocabCount: z.number().int().nonnegative(),
  grammarCount: z.number().int().nonnegative(),
  slidesCount: z.number().int().nonnegative(),
  quizCount: z.number().int().nonnegative(),
});
export type LessonMetaT = z.infer<typeof LessonMeta>;

export type LevelT = z.infer<typeof Level>;
export type TopicT = z.infer<typeof Topic>;
export type VocabT = z.infer<typeof Vocab>;
export type DerivedVocabT = z.infer<typeof DerivedVocab>;
export type DerivedCardT = z.infer<typeof DerivedCard>;
export type GrammarRuleT = z.infer<typeof GrammarRule>;
export type QuoteT = z.infer<typeof Quote>;
export type QuizQuestionT = z.infer<typeof QuizQuestion>;
export type QuizMCT = z.infer<typeof QuizMC>;
export type QuizFillT = z.infer<typeof QuizFill>;
export type QuizTranslateT = z.infer<typeof QuizTranslate>;
export type FlashcardT = z.infer<typeof Flashcard>;
export type SlideT = z.infer<typeof Slide>;
export type LessonT = z.infer<typeof Lesson>;
export type CardDirectionT = z.infer<typeof CardDirection>;

export const CheatsheetExceptionTable = z.object({
  title: z.string().min(1),
  table: z.array(z.array(z.string())),
});

export const CheatsheetSection = z.object({
  id: z.string().regex(SlugRegex),
  title: z.string().min(1),
  main_table: z.array(z.array(z.string())).optional(),
  exception_tables: z.array(CheatsheetExceptionTable).default([]),
  notes: z.array(z.string()).default([]),
  source_lessons: z.array(z.string().regex(SlugRegex)).default([]),
});

export const CheatsheetCategory = z.object({
  id: z.string().regex(SlugRegex),
  title: z.string().min(1),
  sections: z.array(CheatsheetSection).default([]),
});

export const Cheatsheet = z.object({
  processed_lessons: z.array(z.string()).default([]),
  updated_at: z.string().optional(),
  categories: z.array(CheatsheetCategory).default([]),
});

export type CheatsheetExceptionTableT = z.infer<typeof CheatsheetExceptionTable>;
export type CheatsheetSectionT = z.infer<typeof CheatsheetSection>;
export type CheatsheetCategoryT = z.infer<typeof CheatsheetCategory>;
export type CheatsheetT = z.infer<typeof Cheatsheet>;

// ── Learner progress (per section, stored in <section>/_progress.json) ──────

export const Sm2StateSchema = z.object({
  interval: z.number().int().nonnegative(),
  ef: z.number().min(1.3).max(10),
  repetitions: z.number().int().nonnegative(),
  due: z.string().regex(DateRegex),
});

export const DailyState = z.object({
  date: z.string().regex(DateRegex),
  target_learner: z.number().int().nonnegative(),
  learner_target: z.number().int().nonnegative(),
  pairs: z.number().int().nonnegative(),
});

export const QuizResult = z.object({
  best_score: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  last_at: z.string().min(1),
});

export const Progress = z.object({
  sm2: z.record(z.string(), Sm2StateSchema).default({}),
  daily: DailyState.nullable().default(null),
  quiz: z.record(z.string(), QuizResult).default({}),
  activity: z.record(z.string().regex(DateRegex), z.number().int().nonnegative()).default({}),
});

export type Sm2StateT = z.infer<typeof Sm2StateSchema>;
export type DailyStateT = z.infer<typeof DailyState>;
export type QuizResultT = z.infer<typeof QuizResult>;
export type ProgressT = z.infer<typeof Progress>;

export const EMPTY_PROGRESS: ProgressT = { sm2: {}, daily: null, quiz: {}, activity: {} };

// ── Topic catalogue (per section, <section>/_topics.json) ───────────────────
//
// categories are the cheat sheet's categories: id plus a title in the learner
// language. Each topic names the categories its lessons can change (a pure
// vocabulary theme names none) and carries regex sources for the offline
// tagger in scripts/lib/topics.ts, compiled case-insensitively.

export const TopicCategory = z.object({
  id: z.string().regex(SlugRegex),
  title: z.string().min(1),
});

export const TopicEntry = z.object({
  id: z.string().regex(SlugRegex),
  categories: z.array(z.string().regex(SlugRegex)).default([]),
  patterns: z.array(z.string()).default([]),
});

export const TopicCatalog = z.object({
  categories: z.array(TopicCategory).default([]),
  topics: z.array(TopicEntry).default([]),
});

export type TopicCategoryT = z.infer<typeof TopicCategory>;
export type TopicEntryT = z.infer<typeof TopicEntry>;
export type TopicCatalogT = z.infer<typeof TopicCatalog>;

/** A section without _topics.json: six broad topics, each its own cheat-sheet category. */
export const DEFAULT_TOPIC_CATALOG: TopicCatalogT = {
  categories: [
    { id: 'grammar', title: 'Grammar' },
    { id: 'vocabulary', title: 'Vocabulary' },
    { id: 'pronunciation', title: 'Pronunciation' },
    { id: 'conversation', title: 'Conversation' },
    { id: 'reading', title: 'Reading' },
    { id: 'listening', title: 'Listening' },
  ],
  topics: [
    { id: 'grammar', categories: ['grammar'], patterns: ['\\bgrammar\\b', '\\bconjugat', '\\bdeclens'] },
    { id: 'vocabulary', categories: ['vocabulary'], patterns: ['\\bvocabular', '\\blexicon\\b', '\\bword list\\b'] },
    { id: 'conversation', categories: ['conversation'], patterns: ['\\bdialog', '\\bconversation\\b', '\\brole.?play\\b'] },
    { id: 'reading', categories: ['reading'], patterns: ['\\breading\\b'] },
    { id: 'listening', categories: ['listening'], patterns: ['\\blisten', '\\baudio\\b'] },
    { id: 'pronunciation', categories: ['pronunciation'], patterns: ['\\bpronunc', '\\bphonetic', '\\bstress\\b', '\\baccent\\b'] },
  ],
};
