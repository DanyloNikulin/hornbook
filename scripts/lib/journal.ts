// The journal folder is the database. This module is the only place that
// knows its layout; scripts and the server go through it.
//
//   <journal>/journal.config.json        brand, providers, sections[]
//   <journal>/<section>/<date>-<slug>.json   lesson (source of truth)
//   <journal>/<section>/<date>-<slug>.md     rendered, regenerated on save
//   <journal>/<section>/_cheatsheet.json
//   <journal>/<section>/_progress.json       learner state (SM-2, quiz, activity)
//   <journal>/<section>/_topics.json          topic catalogue: categories, topics, tagger patterns
//   <journal>/<section>/_topics-version.json / _topics-suggestions.json / _topic-reviews/
//   <journal>/<section>/_derived/            meta, vocab, cards, search index
//
// Location: HORNBOOK_JOURNAL, else <repo>/journal (the demo journal).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRoot } from './runtime.ts';
import {
  normalizeJournalConfig,
  sectionIdFor,
  type JournalConfigT,
  type SectionConfigT,
} from '../../src/lib/journal-config.ts';
import {
  DEFAULT_TOPIC_CATALOG,
  Lesson,
  TopicCatalog,
  type LessonT,
  type TopicCatalogT,
} from '../../src/lib/schema.ts';
import { buildDerived, type DerivedBundle } from './derived.ts';

const repoRoot = process.env['HORNBOOK_APP_ROOT']?.trim() || packageRoot(import.meta.url);

let journalOverride: string | null = null;

/** Point every helper at another folder (server `--journal`, tests). */
export function setJournalDir(dir: string): void {
  journalOverride = resolve(dir);
  cachedConfig = null;
}

export function journalDir(): string {
  if (journalOverride) return journalOverride;
  const env = process.env['HORNBOOK_JOURNAL'];
  return env ? resolve(env) : join(repoRoot, 'journal');
}

export function repoRootDir(): string {
  return repoRoot;
}

export function configPath(): string {
  return join(journalDir(), 'journal.config.json');
}

let cachedConfig: JournalConfigT | null = null;

export function loadJournalConfig(): JournalConfigT {
  if (cachedConfig) return cachedConfig;
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`Missing journal.config.json at ${path}. Run "npm run migrate" or create a journal.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  cachedConfig = normalizeJournalConfig(raw);
  return cachedConfig;
}

export function saveJournalConfig(config: JournalConfigT): void {
  mkdirSync(journalDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
  cachedConfig = normalizeJournalConfig(config);
}

export function invalidateConfig(): void {
  cachedConfig = null;
}

export function listSections(): readonly SectionConfigT[] {
  return loadJournalConfig().sections;
}

export function getSection(id: string): SectionConfigT {
  const s = listSections().find((x) => x.id === id);
  if (!s) throw new Error(`Unknown section "${id}". Known: ${listSections().map((x) => x.id).join(', ') || '(none)'}`);
  return s;
}

export function sectionDir(id: string): string {
  return join(journalDir(), id);
}

export function derivedDir(id: string): string {
  return join(sectionDir(id), '_derived');
}

export function cheatsheetPath(id: string): string {
  return join(sectionDir(id), '_cheatsheet.json');
}

export function progressPath(id: string): string {
  return join(sectionDir(id), '_progress.json');
}

export function topicsPath(id: string): string {
  return join(sectionDir(id), '_topics.json');
}

/** The section's topic catalogue, or the bundled default when it has none. */
export function readTopicCatalog(id: string): TopicCatalogT {
  const path = topicsPath(id);
  if (!existsSync(path)) return DEFAULT_TOPIC_CATALOG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  const result = TopicCatalog.safeParse(raw);
  if (!result.success) {
    throw new Error(`${path} failed validation\n${JSON.stringify(result.error.format(), null, 2)}`);
  }
  return result.data;
}

export function writeTopicCatalog(id: string, catalog: TopicCatalogT): void {
  const data = TopicCatalog.parse(catalog);
  mkdirSync(sectionDir(id), { recursive: true });
  writeFileSync(topicsPath(id), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function lessonFileStem(lesson: Pick<LessonT, 'date' | 'slug'>): string {
  return `${lesson.date}-${lesson.slug}`;
}

/** Lesson JSON files of a section (names only), underscore files excluded. */
export function lessonFiles(id: string): string[] {
  const dir = sectionDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();
}

export interface LoadedLesson {
  file: string;
  lesson: LessonT;
}

/**
 * Read and validate every lesson of a section. Throws with all errors
 * collected when any file is malformed, so a build fails loudly.
 */
export function readSectionLessons(id: string): LoadedLesson[] {
  const dir = sectionDir(id);
  const errors: string[] = [];
  const out: LoadedLesson[] = [];
  for (const f of lessonFiles(id)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      errors.push(`${id}/${f}: parse error: ${(err as Error).message}`);
      continue;
    }
    const result = Lesson.safeParse(parsed);
    if (!result.success) {
      errors.push(`${id}/${f}: schema validation failed\n${JSON.stringify(result.error.format(), null, 2)}`);
      continue;
    }
    out.push({ file: f, lesson: result.data });
  }
  if (errors.length > 0) {
    throw new Error(`Some lessons failed validation:\n${errors.join('\n')}`);
  }
  return out;
}

/** slug → file name for every lesson of a section (for uniqueness checks). */
export function existingSlugs(id: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = sectionDir(id);
  for (const f of lessonFiles(id)) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { slug?: unknown };
      if (typeof raw.slug === 'string') out.set(raw.slug, f);
    } catch {
      // malformed files are reported by readSectionLessons
    }
  }
  return out;
}

/**
 * Rebuild `_derived/` for a section from its lessons. Returns the bundle so
 * callers (the server) can respond without re-reading the files.
 */
export function writeDerived(id: string): DerivedBundle {
  const section = getSection(id);
  const lessons = readSectionLessons(id).map((l) => l.lesson);
  const bundle = buildDerived(lessons, section.target);
  const dir = derivedDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(bundle.metas, null, 2), 'utf8');
  writeFileSync(join(dir, 'vocab.json'), JSON.stringify(bundle.vocab, null, 2), 'utf8');
  writeFileSync(join(dir, 'cards.json'), JSON.stringify(bundle.cards), 'utf8');
  writeFileSync(join(dir, 'search-index.json'), JSON.stringify(bundle.searchDocs), 'utf8');
  return bundle;
}

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
    throw new Error('No section selected. Pass --section <id> (see journal.config.json → sections).');
  }
  return current;
}

/**
 * Resolve `--section <id>` from argv. With one section in the journal the
 * flag is optional; with several it is required unless `allowDefault` picks
 * the first one.
 */
export function resolveSectionArg(argv: readonly string[], opts: { allowDefault?: boolean } = {}): SectionConfigT {
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

/** Create a section folder and config entry. Returns the new section. */
export function createSection(input: { target: string; learner: string; title?: string; id?: string }): SectionConfigT {
  const config = loadJournalConfig();
  const id = input.id ?? sectionIdFor(input.target, input.learner);
  if (config.sections.some((s) => s.id === id)) {
    throw new Error(`Section "${id}" already exists.`);
  }
  const section: SectionConfigT = { id, target: input.target, learner: input.learner };
  if (input.title) section.title = input.title;
  saveJournalConfig({ ...config, sections: [...config.sections, section] });
  mkdirSync(sectionDir(id), { recursive: true });
  writeDerived(id);
  return section;
}
