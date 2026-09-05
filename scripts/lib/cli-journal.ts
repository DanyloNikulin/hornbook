import { JournalRepository, defaultJournalDir } from './journal.ts';
import type { SectionConfigT } from '../../src/lib/journal-config.ts';
export { lessonFileStem, repoRootDir } from './journal.ts';

const journal = new JournalRepository(defaultJournalDir());
export const configPath = journal.configPath.bind(journal);
export const loadJournalConfig = journal.loadJournalConfig.bind(journal);
export const saveJournalConfig = journal.saveJournalConfig.bind(journal);
export const invalidateConfig = journal.invalidateConfig.bind(journal);
export const listSections = journal.listSections.bind(journal);
export const getSection = journal.getSection.bind(journal);
export const sectionDir = journal.sectionDir.bind(journal);
export const derivedDir = journal.derivedDir.bind(journal);
export const cheatsheetPath = journal.cheatsheetPath.bind(journal);
export const progressPath = journal.progressPath.bind(journal);
export const topicsPath = journal.topicsPath.bind(journal);
export const readTopicCatalog = journal.readTopicCatalog.bind(journal);
export const writeTopicCatalog = journal.writeTopicCatalog.bind(journal);
export const lessonFiles = journal.lessonFiles.bind(journal);
export const readSectionLessons = journal.readSectionLessons.bind(journal);
export const existingSlugs = journal.existingSlugs.bind(journal);
export const writeDerived = journal.writeDerived.bind(journal);
export const createSection = journal.createSection.bind(journal);
export const writeCanonicalLesson = journal.writeLesson.bind(journal);
export const journalDir = journal.journalDir.bind(journal);

// ── Current-section context for the pipeline scripts ────────────────────────
//
// transcribe/extract/prompt builders ask "which languages?" from deep inside
// the call graph. Instead of threading a section through every signature,
// a script resolves its --section once and the helpers read it from here.

let current: SectionConfigT | null = null;

export function useSection(id: string): SectionConfigT {
  current = getSection(id);
  return current;
}

export function currentSection(): SectionConfigT {
  if (!current) {
    throw new Error(
      'No section selected. Pass --section <id> (see journal.config.json → sections).',
    );
  }
  return current;
}

/**
 * Resolve `--section <id>` from argv. With one section in the journal the
 * flag is optional; with several it is required unless `allowDefault` picks
 * the first one.
 */
export function resolveSectionArg(
  argv: readonly string[],
  opts: { allowDefault?: boolean } = {},
): SectionConfigT {
  const i = argv.indexOf('--section');
  const explicit = i >= 0 ? argv[i + 1] : process.env['HORNBOOK_SECTION'];
  const sections = listSections();
  if (explicit) return useSection(explicit);
  if (sections.length === 1 || (opts.allowDefault && sections.length > 0)) {
    return useSection(sections[0].id);
  }
  throw new Error(
    sections.length === 0
      ? 'The journal has no sections. Create one in the app (/setup) or in journal.config.json.'
      : `Several sections exist (${sections.map((s) => s.id).join(', ')}); pass --section <id>.`,
  );
}
