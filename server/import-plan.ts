import type { LessonT, ProgressT } from '../src/lib/schema.ts';
import type {
  ImportConflictStrategy,
  LessonImportConflict,
  LessonImportResult,
} from '../src/lib/api-types.ts';
import { finalizeLesson } from '../scripts/lib/lesson-storage.ts';

export interface ImportPlan {
  readonly results: readonly LessonImportResult[];
  readonly conflicts: readonly LessonImportConflict[];
  readonly removed: readonly LessonT[];
  readonly lessons: readonly LessonT[];
  readonly mapSlug: (slug: string) => string;
  readonly mapId: (id: string) => string;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

/** Reserve every original name first, so suffix allocation never depends on archive order. */
export function planImport(
  existing: readonly LessonT[],
  incoming: readonly LessonT[],
  strategy: ImportConflictStrategy,
  currentProgress?: ProgressT,
  incomingProgress?: ProgressT,
): ImportPlan {
  const bySlug = new Map(existing.map((lesson) => [lesson.slug, lesson]));
  const ids = new Map<string, string>();
  const slugs = new Map<string, string>();
  const historySlugs = (progress?: ProgressT): string[] => progress ? [
    ...Object.keys(progress.quiz),
    ...Object.keys(progress.sm2).flatMap((key) => /^\d{4}-\d{2}-\d{2}-([^:]+)/.exec(key)?.[1] ?? []),
  ] : [];
  const destinationHistory = new Set(historySlugs(currentProgress));
  const used = new Set([...bySlug.keys(), ...incoming.map((lesson) => lesson.slug), ...destinationHistory, ...historySlugs(incomingProgress)]);
  const conflicts: LessonImportConflict[] = [];
  const removed: LessonT[] = [];
  const results: LessonImportResult[] = [];
  if (new Set(incoming.map((lesson) => lesson.slug)).size !== incoming.length)
    throw new Error('Duplicate imported slug');
  for (const original of [...incoming].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  )) {
    const prior = bySlug.get(original.slug);
    let slug = original.slug;
    let action: LessonImportResult['action'] = 'imported';
    if (prior || destinationHistory.has(slug)) {
      conflicts.push({ slug, incomingId: original.id, existingId: prior?.id ?? original.id });
      if (strategy === 'keep-both') {
        let suffix = 2;
        while (used.has(`${slug}-${suffix}`)) suffix++;
        slug = `${slug}-${suffix}`;
        action = 'kept-both';
      } else {
        action = 'replaced';
        if (prior) removed.push(structuredClone(prior));
      }
    }
    used.add(slug);
    const lesson = finalizeLesson(original, { slug });
    ids.set(original.id, lesson.id);
    slugs.set(original.slug, slug);
    results.push({ originalId: original.id, lesson, action });
  }
  const mapSlug = (slug: string): string => slugs.get(slug) ?? slug;
  const mapId = (key: string): string => {
    const end = key.indexOf(':');
    const original = end < 0 ? key : key.slice(0, end);
    return `${ids.get(original) ?? original}${end < 0 ? '' : key.slice(end)}`;
  };
  const final = results.map((result) => ({
    ...result,
    lesson: { ...result.lesson, related: result.lesson.related.map(mapSlug) },
  }));
  const removedSlugs = new Set(removed.map((lesson) => lesson.slug));
  return freezeDeep({
    results: final,
    conflicts,
    removed,
    lessons: [
      ...structuredClone(existing.filter((lesson) => !removedSlugs.has(lesson.slug))),
      ...final.map((result) => result.lesson),
    ],
    mapSlug,
    mapId,
  });
}

export function mergeImportProgress(
  current: ProgressT,
  imported: ProgressT,
  plan: ImportPlan,
): ProgressT {
  const uniqueEntries = <T>(entries: [string, T][]): Record<string, T> => {
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Import would combine distinct study histories; no changes were saved');
    return Object.fromEntries(entries);
  };
  const sm2 = uniqueEntries(
    Object.entries(imported.sm2).map(([key, state]) => [plan.mapId(key), state]),
  );
  const quiz = uniqueEntries(
    Object.entries(imported.quiz).map(([slug, state]) => [plan.mapSlug(slug), state]),
  );
  const activity = { ...current.activity };
  for (const [date, count] of Object.entries(imported.activity))
    activity[date] = Math.max(activity[date] ?? 0, count);
  const a = current.daily;
  const b = imported.daily;
  const daily = !a
    ? b
    : !b
      ? a
      : a.date > b.date
        ? a
        : a.date < b.date
          ? b
          : {
              date: a.date,
              target_learner: Math.max(a.target_learner, b.target_learner),
              learner_target: Math.max(a.learner_target, b.learner_target),
              pairs: Math.max(a.pairs, b.pairs),
            };
  return { sm2: { ...current.sm2, ...sm2 }, quiz: { ...current.quiz, ...quiz }, activity, daily };
}
