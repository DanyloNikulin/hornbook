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

  writeLesson(id: string, input: unknown): LessonT {
    const lesson = finalizeLesson(input);
    return this.commit(() => {
      const section = this.getSection(id);
      const existing = this.readSectionLessons(id).map((entry) => entry.lesson);
      const prior = existing.find((entry) => entry.slug === lesson.slug);
      if (prior && prior.id !== lesson.id) throw new Error(`Slug "${lesson.slug}" is already used by another date`);
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
    const checked = normalizeJournalConfig(config);
    this.commit(() => ({ changes: [{ path: 'journal.config.json', data: JSON.stringify(checked, null, 2) + '\n' }], result: undefined }));
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

  writeTopicCatalog(id: string, catalog: TopicCatalogT): void {
    const data = TopicCatalog.parse(catalog);
    this.commit(() => {
      this.getSection(id);
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
