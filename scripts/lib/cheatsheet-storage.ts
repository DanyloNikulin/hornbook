import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Cheatsheet, type CheatsheetT } from '../../src/lib/schema.ts';
import { JournalRepository } from './journal.ts';

function snapshot(journal: JournalRepository, id: string) {
  const path = journal.cheatsheetPath(id);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let sheet: CheatsheetT;
  try { sheet = raw === null ? { processed_lessons: [], categories: [] } : Cheatsheet.parse(JSON.parse(raw)); }
  catch { throw new Error('Cheat sheet is malformed. Restore _cheatsheet.json from a backup before rebuilding; the original file has been preserved.'); }
  const lessons = journal.readSectionLessons(id);
  const catalog = journal.readTopicCatalog(id);
  const revision = createHash('sha256').update(JSON.stringify([raw, lessons, catalog, journal.getSection(id)])).digest('hex');
  return { sheet, lessons, catalog, revision };
}

export function readCheatsheetBuild(journal: JournalRepository, id: string) {
  return journal.commit(() => ({ changes: [], result: snapshot(journal, id) }));
}

export function publishCheatsheet(journal: JournalRepository, id: string, revision: string, input: CheatsheetT): void {
  const sheet = Cheatsheet.parse(input);
  journal.commit(() => {
    if (snapshot(journal, id).revision !== revision) throw new Error('Cheat sheet sources changed during generation. Previous notes were preserved; retry the build.');
    return { changes: [{ path: `${id}/_cheatsheet.json`, data: JSON.stringify(sheet, null, 2) + '\n' }], result: undefined };
  });
}
