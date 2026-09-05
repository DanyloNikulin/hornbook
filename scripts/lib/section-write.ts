import type { SectionConfigT } from '../../src/lib/journal-config.ts';
import type { LessonT } from '../../src/lib/schema.ts';
import { buildDerived } from './derived.ts';
import type { FileChange } from './file-commit.ts';
import { serializeLesson } from './lesson-storage.ts';
import { lessonToMarkdown } from './markdown.ts';

/** Canonical lesson changes and the projections rebuilt from their final state. */
export function sectionWriteChanges(
  section: SectionConfigT,
  finalLessons: readonly LessonT[],
  changed: readonly LessonT[],
  removed: readonly LessonT[] = [],
): FileChange[] {
  const canonical = changed.map(serializeLesson);
  const destinations = new Set(canonical.map(({ lesson }) => lesson.id));
  const retired = removed.filter((lesson) => !destinations.has(lesson.id));
  const bundle = buildDerived(finalLessons, section.target);
  const base = section.id;
  return [
    ...canonical.map(({ lesson, json }) => ({ path: `${base}/${lesson.id}.json`, data: json })),
    ...retired.map((lesson) => ({ path: `${base}/${lesson.id}.json`, data: null })),
    ...canonical.map(({ lesson }) => ({
      path: `${base}/${lesson.id}.md`,
      data: lessonToMarkdown(lesson),
    })),
    ...retired.map((lesson) => ({ path: `${base}/${lesson.id}.md`, data: null })),
    ...Object.entries({
      meta: bundle.metas,
      vocab: bundle.vocab,
      cards: bundle.cards,
      'search-index': bundle.searchDocs,
      format: { version: 2 },
    }).map(([name, data]) => ({
      path: `${base}/_derived/${name}.json`,
      data: JSON.stringify(data),
    })),
  ];
}
