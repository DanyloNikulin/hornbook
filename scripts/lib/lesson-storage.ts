import { Lesson, LessonShape, type LessonT } from '../../src/lib/schema.ts';
import { lessonContentId } from '../../src/lib/content-ids.ts';

/** Input normalization belongs to writers, after date, slug and title have been chosen. */
export function finalizeLesson(
  input: unknown,
  details: Partial<Pick<LessonT, 'date' | 'slug' | 'title'>> = {},
): LessonT {
  const valid = LessonShape.parse(input);
  return Lesson.parse({ ...valid, ...details });
}

export function serializeLesson(input: unknown): { lesson: LessonT; json: string } {
  const lesson = finalizeLesson(input);
  return { lesson, json: `${JSON.stringify(lesson, null, 2)}\n` };
}

/** Old journals may omit child IDs. Supplied identities are never silently changed on read. */
function legacyContentIds(lesson: ReturnType<typeof LessonShape.parse>): LessonT {
  return {
    ...lesson,
    vocabulary: lesson.vocabulary.map((entry, i) => ({
      ...entry,
      id: entry.id ?? lessonContentId(lesson.id, 'vocab', i),
    })),
    flashcards: lesson.flashcards.map((entry, i) => ({
      ...entry,
      id: entry.id ?? lessonContentId(lesson.id, 'card', i),
    })),
  };
}

export function readStoredLesson(input: unknown): LessonT {
  const lesson = legacyContentIds(LessonShape.parse(input));
  if (
    lesson.id !== `${lesson.date}-${lesson.slug}` ||
    lesson.vocabulary.some((entry, i) => entry.id !== lessonContentId(lesson.id, 'vocab', i)) ||
    lesson.flashcards.some((entry, i) => entry.id !== lessonContentId(lesson.id, 'card', i))
  ) {
    throw new Error(
      'Stored lesson identities are inconsistent. Run scripts/repair-lesson-identities.ts --section <id> with HORNBOOK_JOURNAL set to this journal.',
    );
  }
  return lesson;
}
