import { existsSync, readFileSync } from 'node:fs';
import { Progress, LessonShape } from '../../src/lib/schema.ts';
import type { JournalRepository } from './journal.ts';
import { finalizeLesson } from './lesson-storage.ts';
import { sectionWriteChanges } from './section-write.ts';

/** Explicit compatibility migration; ordinary reads never persist identity changes. */
export function repairLessonIdentities(journal: JournalRepository, id: string): number {
  return journal.commit(() => {
    const section = journal.getSection(id);
    const files = journal.lessonFiles(id);
    const originals = files.map((file) =>
      LessonShape.parse(JSON.parse(readFileSync(journal.sectionPath(id, file), 'utf8'))),
    );
    const lessons = originals.map((lesson) => finalizeLesson(lesson));
    if (new Set(lessons.map((lesson) => lesson.slug)).size !== lessons.length)
      throw new Error('Duplicate lesson slugs require manual repair');
    const identities = new Map<string, string>();
    const add = (from: string, to: string) => {
      if (identities.has(from) && identities.get(from) !== to)
        throw new Error('Ambiguous legacy identities require manual repair');
      identities.set(from, to);
    };
    originals.forEach((old, i) => {
      add(old.id, lessons[i].id);
      for (const kind of ['vocabulary', 'flashcards'] as const) {
        old[kind].forEach((entry, n) => {
          if (entry.id) add(entry.id, lessons[i][kind][n].id);
        });
      }
    });
    const changes = sectionWriteChanges(section, lessons, lessons);
    const destinations = new Set(lessons.map((lesson) => `${lesson.id}.json`));
    for (const file of files.filter((file) => !destinations.has(file))) {
      changes.push(
        { path: `${id}/${file}`, data: null },
        { path: `${id}/${file.replace(/\.json$/, '.md')}`, data: null },
      );
    }
    const path = journal.progressPath(id);
    if (existsSync(path)) {
      const progress = Progress.parse(JSON.parse(readFileSync(path, 'utf8')));
      const remapped: typeof progress.sm2 = {};
      for (const [key, state] of Object.entries(progress.sm2)) {
        let mapped = key;
        // Longest original prefix handles explicit child IDs before lesson-wide IDs.
        for (const prefix of [...identities.keys()].sort((a, b) => b.length - a.length)) {
          if (key === prefix || key.startsWith(prefix + ':')) {
            mapped = identities.get(prefix)! + key.slice(prefix.length);
            break;
          }
        }
        if (Object.hasOwn(remapped, mapped))
          throw new Error('Progress identity collision requires manual repair');
        remapped[mapped] = state;
      }
      changes.push({
        path: `${id}/_progress.json`,
        data: JSON.stringify({ ...progress, sm2: remapped }, null, 2) + '\n',
      });
    }
    return { changes, result: lessons.length };
  });
}
