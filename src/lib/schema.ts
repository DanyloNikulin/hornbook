import { z } from 'zod';

export const Level = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

const DateRegex = /^\d{4}-\d{2}-\d{2}$/;
const SlugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const TOPIC_VOCAB = [
  // Tenses
  'grammar',
  // Verb classes
  'vocabulary',
  // Specific common verbs
  'conversation',
  // Articles, nouns, prepositions
  'reading',
  // Pronouns
  'listening',
  // Adjectives
  // Reading & pronunciation
  'pronunciation',
  // Set-phrase constructions
  // Themes / vocabulary domains
] as const;

export const Topic = z.enum(TOPIC_VOCAB);

export const Vocab = z.object({
  target: z.string().min(1),
  learner: z.string().min(1),
  level: Level.nullable().optional(),
  example_target: z.string().optional(),
  example_learner: z.string().optional(),
});

export const DerivedVocab = z.object({
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

export const Lesson = z.object({
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
