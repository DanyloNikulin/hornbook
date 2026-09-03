import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lesson, DerivedCard, DerivedVocab, LessonMeta, QuizMC } from './schema';

// Every lesson of the demo journal must satisfy the schema, and the derived
// files the server writes for it must too. The first section of the demo
// journal is used; `npm run build-data` (the pretest hook) regenerates
// `_derived/` before this runs.

// `ng test` bundles specs and serves them, so `import.meta.url` is an http
// URL here, not a file:// one. Vitest roots itself at the workspace, so cwd
// is the reliable way back to the repo.
const repoRoot = process.cwd();
const JOURNAL_DIR = join(repoRoot, 'journal');
const SECTION_ID = (JSON.parse(readFileSync(join(JOURNAL_DIR, 'journal.config.json'), 'utf8')) as {
  sections: { id: string }[];
}).sections[0].id;
const LESSONS_DIR = join(JOURNAL_DIR, SECTION_ID);
const META_PATH = join(LESSONS_DIR, '_derived', 'meta.json');
const VOCAB_PATH = join(LESSONS_DIR, '_derived', 'vocab.json');
const CARDS_PATH = join(LESSONS_DIR, '_derived', 'cards.json');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const lessonFiles = readdirSync(LESSONS_DIR).filter(
  (f) => f.endsWith('.json') && !f.startsWith('_'),
);

describe('schema — committed lessons', () => {
  it('lesson directory is non-empty', () => {
    expect(lessonFiles.length).toBeGreaterThan(0);
  });

  it.each(lessonFiles.map((f) => [f] as const))('lesson %s validates', (file) => {
    const raw = readJson(join(LESSONS_DIR, file));
    const result = Lesson.safeParse(raw);
    if (!result.success) {
      throw new Error(`Validation failed:\n${JSON.stringify(result.error.format(), null, 2)}`);
    }
    expect(result.success).toBe(true);
  });
});

describe('schema — Lesson shape', () => {
  it('rejects missing required fields', () => {
    expect(Lesson.safeParse({}).success).toBe(false);
    expect(Lesson.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('rejects bad date format', () => {
    const base = {
      id: 'x',
      date: 'not-a-date',
      slug: 'x',
      title: 'x',
      summary: 'x',
      article_md: 'x',
    };
    expect(Lesson.safeParse(base).success).toBe(false);
  });

  it('rejects bad slug format (uppercase)', () => {
    const base = {
      id: 'x',
      date: '2026-05-23',
      slug: 'Bad-Slug',
      title: 'x',
      summary: 'x',
      article_md: 'x',
    };
    expect(Lesson.safeParse(base).success).toBe(false);
  });

  it('accepts minimal valid lesson with empty arrays defaulted', () => {
    const base = {
      id: '2026-05-23-x',
      date: '2026-05-23',
      slug: 'x',
      title: 'X',
      summary: 'Підсумок',
      article_md: '# X',
    };
    const result = Lesson.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vocabulary).toEqual([]);
      expect(result.data.grammar).toEqual([]);
      expect(result.data.quiz).toEqual([]);
    }
  });
});

describe('schema — multiple-choice questions', () => {
  it('accepts an answer index inside the options array', () => {
    expect(
      QuizMC.safeParse({
        type: 'mc',
        q: 'Choose one',
        options: ['a', 'b'],
        answer: 1,
      }).success,
    ).toBe(true);
  });

  it('rejects an answer index outside the options array', () => {
    expect(
      QuizMC.safeParse({
        type: 'mc',
        q: 'Choose one',
        options: ['a', 'b'],
        answer: 2,
      }).success,
    ).toBe(false);
  });
});

describe('schema — committed lesson meta manifest', () => {
  const raw = readJson(META_PATH);
  if (!Array.isArray(raw)) throw new Error('_derived/meta.json must be an array');

  it('manifest is non-empty', () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it.each(raw.map((m, i) => [i, (m as { slug?: string }).slug ?? `index-${i}`, m] as const))(
    'meta %i (%s) validates',
    (_idx, _slug, m) => {
      const result = LessonMeta.safeParse(m);
      if (!result.success) {
        throw new Error(`Validation failed:\n${JSON.stringify(result.error.format(), null, 2)}`);
      }
      expect(result.success).toBe(true);
    },
  );

  it('manifest sorted newest-first', () => {
    const dates = (raw as { date: string }[]).map((m) => m.date);
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : -1));
    expect(dates).toEqual(sorted);
  });
});

describe('schema — LessonMeta shape', () => {
  const valid = {
    slug: 'foo',
    date: '2026-05-23',
    title: 'Foo',
    summary: 'bar',
    topics: [],
    vocabCount: 0,
    grammarCount: 0,
    slidesCount: 0,
    quizCount: 0,
  };

  it('accepts a valid LessonMeta', () => {
    expect(LessonMeta.safeParse(valid).success).toBe(true);
  });

  it('rejects bad slug (uppercase)', () => {
    expect(LessonMeta.safeParse({ ...valid, slug: 'BAD' }).success).toBe(false);
  });

  it('rejects bad date format', () => {
    expect(LessonMeta.safeParse({ ...valid, date: 'tomorrow' }).success).toBe(false);
  });

  it('rejects negative counts', () => {
    expect(LessonMeta.safeParse({ ...valid, vocabCount: -1 }).success).toBe(false);
    expect(LessonMeta.safeParse({ ...valid, grammarCount: -1 }).success).toBe(false);
    expect(LessonMeta.safeParse({ ...valid, slidesCount: -1 }).success).toBe(false);
    expect(LessonMeta.safeParse({ ...valid, quizCount: -1 }).success).toBe(false);
  });

  it('accepts optional duration_min', () => {
    expect(LessonMeta.safeParse({ ...valid, duration_min: 45 }).success).toBe(true);
  });

  it('rejects unknown topics', () => {
    expect(LessonMeta.safeParse({ ...valid, topics: ['not-a-real-topic'] }).success).toBe(false);
  });
});

describe('schema — committed vocab', () => {
  const raw = readJson(VOCAB_PATH);
  if (!Array.isArray(raw)) throw new Error('_vocab.json must be an array');

  it('vocab list is non-empty', () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it.each(raw.map((v, i) => [i, (v as { target?: string }).target ?? `index-${i}`, v] as const))(
    'vocab %i (%s) validates',
    (_idx, _it, v) => {
      const result = DerivedVocab.safeParse(v);
      if (!result.success) {
        throw new Error(`Validation failed:\n${JSON.stringify(result.error.format(), null, 2)}`);
      }
      expect(result.success).toBe(true);
    },
  );
});

describe('schema — DerivedVocab shape', () => {
  const validEntry = {
    target: 'casa',
    learner: 'house',
    level: 'A1' as const,
    example_target: 'La casa è grande.',
    example_learner: 'Будинок великий.',
    first_seen: 'lesson-one',
    first_seen_date: '2026-05-01',
    seen_in: ['lesson-one', 'lesson-two'],
  };

  it('accepts a valid DerivedVocab entry', () => {
    const result = DerivedVocab.safeParse(validEntry);
    expect(result.success).toBe(true);
  });

  it('accepts null level', () => {
    const result = DerivedVocab.safeParse({ ...validEntry, level: null });
    expect(result.success).toBe(true);
  });

  it('accepts entry without optional example fields', () => {
    const minimal: Record<string, unknown> = { ...validEntry };
    delete minimal['example_target'];
    delete minimal['example_learner'];
    const result = DerivedVocab.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('rejects missing target', () => {
    const broken: Record<string, unknown> = { ...validEntry };
    delete broken['target'];
    expect(DerivedVocab.safeParse(broken).success).toBe(false);
  });

  it('rejects empty target', () => {
    expect(DerivedVocab.safeParse({ ...validEntry, target: '' }).success).toBe(false);
  });

  it('rejects missing learner', () => {
    const broken: Record<string, unknown> = { ...validEntry };
    delete broken['learner'];
    expect(DerivedVocab.safeParse(broken).success).toBe(false);
  });

  it('rejects bad first_seen slug (uppercase)', () => {
    expect(DerivedVocab.safeParse({ ...validEntry, first_seen: 'Bad-Slug' }).success).toBe(false);
  });

  it('rejects bad first_seen_date format', () => {
    expect(DerivedVocab.safeParse({ ...validEntry, first_seen_date: 'tomorrow' }).success).toBe(
      false,
    );
  });

  it('rejects seen_in entries with bad slug', () => {
    expect(DerivedVocab.safeParse({ ...validEntry, seen_in: ['ok', 'BAD'] }).success).toBe(false);
  });
});

describe('schema — committed derived cards', () => {
  const raw = readJson(CARDS_PATH);
  if (!Array.isArray(raw)) throw new Error('_cards.json must be an array');

  it('card list is non-empty', () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it.each(
    raw.map((card, i) => [i, (card as { front?: string }).front ?? `index-${i}`, card] as const),
  )('card %i (%s) validates', (_idx, _front, card) => {
    const result = DerivedCard.safeParse(card);
    if (!result.success) {
      throw new Error(`Validation failed:\n${JSON.stringify(result.error.format(), null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  it('card ids are unique', () => {
    const ids = raw.map((card) => (card as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('schema — DerivedCard shape', () => {
  const valid = {
    id: 'abc123',
    front: 'la casa',
    back: 'будинок',
    direction: 'target-learner' as const,
    source: 'vocab' as const,
    type: 'word' as const,
    tags: ['A1'],
    lessons: ['lesson-one'],
    expected: 'будинок',
  };

  it('accepts a valid card', () => {
    expect(DerivedCard.safeParse(valid).success).toBe(true);
  });

  it('rejects unsupported direction and source', () => {
    expect(DerivedCard.safeParse({ ...valid, direction: 'both' }).success).toBe(false);
    expect(DerivedCard.safeParse({ ...valid, source: 'manual' }).success).toBe(false);
  });

  it('requires at least one valid lesson slug', () => {
    expect(DerivedCard.safeParse({ ...valid, lessons: [] }).success).toBe(false);
    expect(DerivedCard.safeParse({ ...valid, lessons: ['Bad-Slug'] }).success).toBe(false);
  });
});
