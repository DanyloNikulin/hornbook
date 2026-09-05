import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeJournalConfig } from '../../src/lib/journal-config.ts';
import { commitFiles, type CommitObserver, type FileChange } from './file-commit.ts';
import { finalizeLesson } from './lesson-storage.ts';
import { sectionWriteChanges } from './section-write.ts';

/** Copy validated sources in one commit. Originals remain available for manual archival. */
export function migrateLegacyJournal(
  source: string,
  destination: string,
  dry = false,
  observer?: CommitObserver,
): string[] {
  const plan = () => {
    if (existsSync(join(destination, 'journal.config.json'))) return { changes: [], result: [] };
    const config = normalizeJournalConfig(
      JSON.parse(readFileSync(join(source, 'journal.config.json'), 'utf8')),
    );
    if (config.sections.length !== 1)
      throw new Error('Legacy migration requires exactly one section');
    const section = config.sections[0];
    const dir = join(source, 'lessons');
    const names = existsSync(dir) ? readdirSync(dir).sort() : [];
    const lessons = names
      .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
      .map((name) => finalizeLesson(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
    if (new Set(lessons.map((lesson) => lesson.slug)).size !== lessons.length)
      throw new Error('Duplicate legacy lesson slug');
    const changes: FileChange[] = sectionWriteChanges(section, lessons, lessons);
    const projections = new Set([
      '_vocab.json',
      '_cards.json',
      '_search-index.json',
      ...names.filter((name) => !name.startsWith('_') && /\.(json|md)$/.test(name)),
    ]);
    for (const name of names.filter((name) => !projections.has(name))) {
      if (!lstatSync(join(dir, name)).isFile())
        throw new Error(`Archive legacy directory separately before migrating: ${name}`);
      changes.push({ path: `${section.id}/${name}`, data: readFileSync(join(dir, name)) });
    }
    if (existsSync(join(source, 'cheatsheet.json')))
      changes.push({
        path: `${section.id}/_cheatsheet.json`,
        data: readFileSync(join(source, 'cheatsheet.json')),
      });
    changes.push({ path: 'journal.config.json', data: JSON.stringify(config, null, 2) + '\n' });
    for (const change of changes) {
      if (existsSync(join(destination, change.path)))
        throw new Error(`Migration destination already contains ${change.path}`);
    }
    return { changes, result: changes.map((change) => change.path) };
  };
  return dry ? plan().result : commitFiles(destination, plan, observer);
}
