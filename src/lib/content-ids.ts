export type LessonContentKind = 'vocab' | 'card';
export type StudyDirection = 'target-learner' | 'learner-target';

/** Stable within one lesson version; importing under another lesson id re-keys cleanly. */
export function lessonContentId(lessonId: string, kind: LessonContentKind, index: number): string {
  return `${lessonId}:${kind}:${String(index + 1).padStart(3, '0')}`;
}

export function studyCardId(contentId: string, direction: StudyDirection): string {
  return `${contentId}:${direction}`;
}

export function remapLessonScopedId(value: string, fromLessonId: string, toLessonId: string): string {
  const prefix = `${fromLessonId}:`;
  return value.startsWith(prefix) ? `${toLessonId}:${value.slice(prefix.length)}` : value;
}
