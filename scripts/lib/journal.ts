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

import {
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  rmdirSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { packageRoot } from './runtime.ts';
import {
  SectionConfig,
  normalizeJournalConfig,
  sectionIdFor,
  type JournalConfigT,
  type SectionConfigT,
} from '../../src/lib/journal-config.ts';
import {
  DEFAULT_TOPIC_CATALOG,
  TopicCatalog,
  type LessonT,
  type TopicCatalogT,
} from '../../src/lib/schema.ts';
import { buildDerived, type DerivedBundle } from './derived.ts';
import { commitFiles, recoverJournal, type FileChange, type CommitObserver } from './file-commit.ts';
import { finalizeLesson, readStoredLesson } from './lesson-storage.ts';
import { sectionWriteChanges } from './section-write.ts';

const repoRoot = process.env['HORNBOOK_APP_ROOT']?.trim() || packageRoot(import.meta.url);
export const DERIVED_FORMAT_VERSION = 2;

export function defaultJournalDir(): string {
  return resolve(process.env['HORNBOOK_JOURNAL'] || join(repoRoot, 'journal'));
}

export function repoRootDir(): string {
  return repoRoot;
}

export function lessonFileStem(lesson: Pick<LessonT, 'date' | 'slug'>): string {
  return `${lesson.date}-${lesson.slug}`;
}

export interface LoadedLesson {
  file: string;
  lesson: LessonT;
}

export class SectionNotEmptyError extends Error {}
export class LessonConflictError extends Error {}

function configChange(config: JournalConfigT): FileChange {
  return { path: 'journal.config.json', data: JSON.stringify(normalizeJournalConfig(config), null, 2) + '\n' };
}

export class JournalRepository {
  readonly root: string;
  private cachedConfig: JournalConfigT | null = null;

  private writing = false;

  constructor(root: string, private readonly observeCommit?: CommitObserver) {
    this.root = resolve(root);
    recoverJournal(this.root);
  }

  private ready(): void {
    if (!this.writing && recoverJournal(this.root)) this.invalidateConfig();
  }

  commit<T>(plan: () => { changes: readonly FileChange[]; result: T }): T {
    if (this.writing) throw new Error('Nested journal commit');
    this.writing = true;
    this.invalidateConfig();
    try { return commitFiles(this.root, plan, this.observeCommit); }
    finally { this.writing = false; this.invalidateConfig(); }
  }

  writeLesson(id: string, input: unknown, mode: 'create' | 'replace' = 'create'): LessonT {
    const lesson = finalizeLesson(input);
    return this.commit(() => {
      const section = this.getSection(id);
      const existing = this.readSectionLessons(id).map((entry) => entry.lesson);
      const prior = existing.find((entry) => entry.slug === lesson.slug);
      if (prior && (mode === 'create' || prior.id !== lesson.id)) throw new LessonConflictError(`Slug "${lesson.slug}" is already used by another lesson`);
      if (!prior && mode === 'replace') throw new LessonConflictError(`No lesson "${lesson.slug}" to replace`);
      const final = [...existing.filter((entry) => entry.slug !== lesson.slug), lesson];
      return { changes: sectionWriteChanges(section, final, [lesson]), result: lesson };
    });
  }

  journalDir(): string {
    return this.root;
  }

  private checkSectionPath(dir: string): void {
    const child = relative(this.root, dir);
    if (!child || child.startsWith('..' + sep) || child === '..' || isAbsolute(child)) {
      throw new Error('Section path escapes the journal');
    }
    // Reject links before creating, removing or writing any section contents.
    if (
      existsSync(dir) &&
      (lstatSync(dir).isSymbolicLink() ||
        relative(realpathSync(this.root), realpathSync(dir)) !== child)
    ) {
      throw new Error('Section path is redirected outside its owned directory');
    }
  }

  configPath(): string {
    this.ready();
    return join(this.journalDir(), 'journal.config.json');
  }

  loadJournalConfig(): JournalConfigT {
    this.ready();
    if (this.cachedConfig) return this.cachedConfig;
    const path = this.configPath();
    if (!existsSync(path)) {
      throw new Error(
        `Missing journal.config.json at ${path}. Run "npm run migrate" or create a journal.`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`, { cause: err });
    }
    this.cachedConfig = normalizeJournalConfig(raw);
    return this.cachedConfig;
  }

  saveJournalConfig(config: JournalConfigT): void {
    const change = configChange(config);
    this.commit(() => ({ changes: [change], result: undefined }));
  }

  initializeJournalConfig(config: JournalConfigT): void {
    this.commit(() => ({ changes: existsSync(this.configPath()) ? [] : [configChange(config)], result: undefined }));
  }

  /** Ordinary updates always transform the latest configuration under the writer lock. */
  updateJournalConfig(update: (current: JournalConfigT) => JournalConfigT): JournalConfigT {
    return this.commit(() => {
      const config = normalizeJournalConfig(update(this.loadJournalConfig()));
      return { changes: [configChange(config)], result: config };
    });
  }

  updateSection(id: string, update: (current: SectionConfigT) => SectionConfigT): SectionConfigT {
    const config = this.updateJournalConfig((current) => {
      const next = SectionConfig.parse(update(this.getSection(id)));
      if (next.id !== id) throw new Error('A section update cannot change its identity');
      return { ...current, sections: current.sections.map((section) => section.id === id ? next : section) };
    });
    return config.sections.find((section) => section.id === id)!;
  }

  writeBackdrop(id: string, image: { name: string; data: Uint8Array } | null): SectionConfigT {
    if (image && !/^_backdrop\.[a-z0-9]+$/.test(image.name)) throw new Error('Invalid backdrop filename');
    return this.commit(() => {
      const section = this.getSection(id);
      const dir = this.sectionDir(id);
      const changes: FileChange[] = (existsSync(dir) ? readdirSync(dir) : [])
        .filter((name) => /^_backdrop\./.test(name) && name !== image?.name)
        .map((name) => ({ path: `${id}/${name}`, data: null }));
      const theme = { ...section.theme };
      if (image) {
        changes.push({ path: `${id}/${image.name}`, data: image.data });
        theme.backdrop = image.name;
      } else delete theme.backdrop;
      const next = { ...section };
      if (Object.keys(theme).length) next.theme = theme; else delete next.theme;
      const config = this.loadJournalConfig();
      changes.push(configChange({ ...config, sections: config.sections.map((s) => s.id === id ? next : s) }));
      return { changes, result: next };
    });
  }

  deleteSection(id: string): void {
    const directories = this.commit(() => {
      this.getSection(id);
      if (this.lessonFiles(id).length) throw new SectionNotEmptyError(`Section "${id}" still has lessons; delete them first`);
      const changes: FileChange[] = [];
      const directories: string[] = [];
      const collect = (parts: string[]) => {
        const dir = this.sectionPath(id, ...parts);
        if (!existsSync(dir)) return;
        directories.push(dir);
        for (const name of readdirSync(dir)) {
          const child = [...parts, name];
          const path = this.sectionPath(id, ...child);
          if (lstatSync(path).isDirectory()) collect(child);
          else changes.push({ path: [id, ...child].join('/'), data: null });
        }
      };
      collect([]);
      const config = this.loadJournalConfig();
      changes.push(configChange({ ...config, sections: config.sections.filter((s) => s.id !== id) }));
      return { changes, result: directories };
    });
    // Only empty directories are disposable after commit; another writer may recreate the section.
    for (const dir of directories.reverse()) {
      try { rmdirSync(dir); } catch { /* Empty directory cleanup can be retried manually. */ }
    }
  }

  invalidateConfig(): void {
    this.cachedConfig = null;
  }

  listSections(): readonly SectionConfigT[] {
    return this.loadJournalConfig().sections;
  }

  getSection(id: string): SectionConfigT {
    SectionConfig.shape.id.parse(id);
    const s = this.listSections().find((x) => x.id === id);
    if (!s)
      throw new Error(
        `Unknown section "${id}". Known: ${
          this.listSections()
            .map((x) => x.id)
            .join(', ') || '(none)'
        }`,
      );
    return s;
  }

  sectionDir(id: string): string {
    this.ready();
    this.getSection(id);
    const dir = resolve(this.root, id);
    this.checkSectionPath(dir);
    return dir;
  }

  sectionPath(id: string, ...parts: string[]): string {
    let path = this.sectionDir(id);
    for (const part of parts) {
      if (!part || part === '.' || part === '..' || /[/\\:\0]/.test(part)) {
        throw new Error('Invalid section filename');
      }
      path = join(path, part);
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('Section file is a symbolic link');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return path;
  }

  derivedDir(id: string): string {
    return this.sectionPath(id, '_derived');
  }

  cheatsheetPath(id: string): string {
    return this.sectionPath(id, '_cheatsheet.json');
  }

  progressPath(id: string): string {
    return this.sectionPath(id, '_progress.json');
  }

  topicsPath(id: string): string {
    return this.sectionPath(id, '_topics.json');
  }

  /** The section's topic catalogue, or the bundled default when it has none. */
  readTopicCatalog(id: string): TopicCatalogT {
    const path = this.topicsPath(id);
    if (!existsSync(path)) return DEFAULT_TOPIC_CATALOG;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`, { cause: err });
    }
    const result = TopicCatalog.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `${path} failed validation\n${JSON.stringify(result.error.format(), null, 2)}`,
      );
    }
    return result.data;
  }

  writeTopicCatalog(id: string, catalog: TopicCatalogT, expected?: TopicCatalogT): void {
    const data = TopicCatalog.parse(catalog);
    this.commit(() => {
      this.getSection(id);
      if (expected && JSON.stringify(this.readTopicCatalog(id)) !== JSON.stringify(TopicCatalog.parse(expected))) {
        throw new Error('Topic catalogue changed during review. Current topics were preserved; run a new review to use the latest catalogue.');
      }
      return { changes: [{ path: `${id}/_topics.json`, data: JSON.stringify(data, null, 2) + '\n' }], result: undefined };
    });
  }

  /** Lesson JSON files of a section (names only), underscore files excluded. */
  lessonFiles(id: string): string[] {
    const dir = this.sectionDir(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort();
  }

  /**
   * Read and validate every lesson of a section. Throws with all errors
   * collected when any file is malformed, so a build fails loudly.
   */
  readSectionLessons(id: string): LoadedLesson[] {
    const errors: string[] = [];
    const out: LoadedLesson[] = [];
    for (const f of this.lessonFiles(id)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(this.sectionPath(id, f), 'utf8'));
      } catch (err) {
        errors.push(`${id}/${f}: parse error: ${(err as Error).message}`);
        continue;
      }
      try { out.push({ file: f, lesson: readStoredLesson(parsed) }); }
      catch (error) { errors.push(`${id}/${f}: ${(error as Error).message}`); }
    }
    if (errors.length > 0) {
      throw new Error(`Some lessons failed validation:\n${errors.join('\n')}`);
    }
    return out;
  }

  /** slug → file name for every lesson of a section (for uniqueness checks). */
  existingSlugs(id: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const f of this.lessonFiles(id)) {
      try {
        const raw = JSON.parse(readFileSync(this.sectionPath(id, f), 'utf8')) as { slug?: unknown };
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
  writeDerived(id: string): DerivedBundle {
    return this.commit(() => {
      const section = this.getSection(id);
      const lessons = this.readSectionLessons(id).map((entry) => entry.lesson);
      return { changes: sectionWriteChanges(section, lessons, []), result: buildDerived(lessons, section.target) };
    });
  }

  /** Create a section folder and config entry. Returns the new section. */
  createSection(input: {
    target: string;
    learner: string;
    title?: string;
    id?: string;
  }): SectionConfigT {
    return this.commit(() => {
    const config = this.loadJournalConfig();
    const id = input.id ?? sectionIdFor(input.target, input.learner);
    if (config.sections.some((s) => s.id === id)) {
      throw new Error(`Section "${id}" already exists.`);
    }
    const section: SectionConfigT = { id, target: input.target, learner: input.learner };
    if (input.title) section.title = input.title;
    SectionConfig.parse(section);
    this.checkSectionPath(resolve(this.root, id));
    return { changes: [
      ...sectionWriteChanges(section, [], []),
      { path: 'journal.config.json', data: JSON.stringify({ ...config, sections: [...config.sections, section] }, null, 2) + '\n' },
    ], result: section };
    });
  }
}
