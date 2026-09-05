// FolderStore: every read and write the API does against the journal folder.
// Thin on purpose — the layout lives in scripts/lib/journal.ts, validation in
// src/lib/schema.ts, derived data in scripts/lib/derived.ts. This class adds
// the HTTP-facing rules (404/409) and keeps derived files fresh on writes.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import {
  Cheatsheet,
  Lesson,
  LessonMeta,
  type CheatsheetT,
  type LessonMetaT,
  type LessonT,
  type ProgressT,
} from '../src/lib/schema.ts';
import {
  SectionConfig,
  Providers,
  SectionTheme,
  sectionIdFor,
  sectionTitle,
  type JournalConfigT,
  type SectionConfigT,
} from '../src/lib/journal-config.ts';
import { languageFlag } from '../src/lib/languages.ts';
import {
  CONNECTION_KEYS,
  type SectionSummary,
  type ConfigView,
  type SettingsView,
  type ProbeResult,
  type LessonImportResult,
  type SectionImportResult,
} from '../src/lib/api-types.ts';
import { connectionViews, planSecretsUpdate } from './secrets.ts';
import { parseProbeInput, probePipeline } from './probe.ts';
import { JournalRepository, LessonConflictError, SectionNotEmptyError, defaultJournalDir, DERIVED_FORMAT_VERSION, lessonFileStem } from '../scripts/lib/journal.ts';
import { z } from 'zod';
import { JournalProgress, ProgressError } from './progress.ts';
import type { ProgressView } from '../src/lib/api-types.ts';
import { planImport, mergeImportProgress } from './import-plan.ts';
import { sectionWriteChanges } from '../scripts/lib/section-write.ts';
import { readStoredLesson } from '../scripts/lib/lesson-storage.ts';
import type { FileChange, CommitObserver } from '../scripts/lib/file-commit.ts';
import {
  BACKDROP_EXTENSIONS,
  buildSectionArchive,
  MAX_SECTION_ARCHIVE_BYTES,
  readSectionArchive,
} from './transfers.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type { SectionSummary, ConfigView } from '../src/lib/api-types.ts';

export type DerivedKind = 'vocab' | 'cards' | 'search-index';

const DEFAULT_CONFIG: JournalConfigT = {
  brand: { name: 'Hornbook', tagline: 'conspects from your lessons' },
  providers: {
    transcribe: { driver: 'skip', model: '-' },
    extract: { driver: 'ollama', model: 'llama3.1' },
  },
  sections: [],
};

const CreateSectionInput = z.object({
  target: z.string().regex(/^[a-z]{2}$/),
  learner: z.string().regex(/^[a-z]{2}$/),
  title: z.string().min(1).max(80).optional(),
  id: SectionConfig.shape.id.optional(),
});

const UpdateSectionInput = z.object({
  title: z.string().min(1).max(80).nullable().optional(),
  theme: SectionTheme.nullable().optional(),
  providers: Providers.partial().nullable().optional(),
});

const MAX_BACKDROP_BYTES = 8 * 1024 * 1024;
const BS = String.fromCharCode(92);

const BackdropInput = z.object({
  filename: z.string().min(1).max(200),
  base64: z.string().min(1),
});

const SettingsUpdateInput = z.object({
  providers: Providers.optional(),
  connections: z
    .object(Object.fromEntries(CONNECTION_KEYS.map((k) => [k, z.string().max(4096).nullable().optional()])))
    .optional(),
});

const ConflictStrategy = z.enum(['error', 'keep-both', 'replace']);
const LessonImportInput = z.object({
  lesson: z.unknown(),
  conflict: ConflictStrategy.default('error'),
});
const SectionImportInput = z.object({
  base64: z.string().min(1),
  conflict: ConflictStrategy.default('error'),
});

export class FolderStore {
  private readonly journal: JournalRepository;

  constructor(journalDir = defaultJournalDir(), observeCommit?: CommitObserver) {
    this.journal = new JournalRepository(journalDir, observeCommit);
    this.ensureJournal();
  }

  get dir(): string {
    return this.journal.journalDir();
  }

  /** A missing journal is created with defaults and no sections. */
  private ensureJournal(): void {
    if (!existsSync(this.journal.configPath())) {
      this.journal.initializeJournalConfig(DEFAULT_CONFIG);
    }
  }

  // ── config & sections ────────────────────────────────────────────────────

  config(): ConfigView {
    this.journal.invalidateConfig();
    const c = this.journal.loadJournalConfig();
    return { brand: c.brand, providers: c.providers, sections: c.sections.map((s) => this.summarize(s)) };
  }

  private summarize(s: SectionConfigT): SectionSummary {
    return {
      ...s,
      label: sectionTitle(s),
      flags: { target: languageFlag(s.target), learner: languageFlag(s.learner) },
      lessonCount: this.journal.lessonFiles(s.id).length,
    };
  }

  section(id: string): SectionConfigT {
    this.journal.invalidateConfig();
    const s = this.journal.listSections().find((x) => x.id === id);
    if (!s) throw new HttpError(404, `Unknown section "${id}"`);
    return s;
  }

  createSection(input: unknown): SectionSummary {
    const parsed = CreateSectionInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid section', parsed.error.format());
    const { target, learner, title, id } = parsed.data;
    if (target === learner) throw new HttpError(400, 'Target and learner language must differ');
    this.journal.invalidateConfig();
    const wantId = id ?? sectionIdFor(target, learner);
    if (this.journal.listSections().some((s) => s.id === wantId)) {
      throw new HttpError(409, `Section "${wantId}" already exists`);
    }
    const created = this.journal.createSection({ target, learner, title, id: wantId });
    return this.summarize(created);
  }

  updateSection(id: string, input: unknown): SectionSummary {
    const parsed = UpdateSectionInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid section update', parsed.error.format());
    this.section(id);
    const next = this.journal.updateSection(id, (current) => {
      const next = { ...current };
      const patch = parsed.data;
      if (patch.title === null) delete next.title;
      else if (patch.title !== undefined) next.title = patch.title;
      if (patch.theme === null) delete next.theme;
      else if (patch.theme !== undefined) next.theme = patch.theme;
      if (patch.providers === null) delete next.providers;
      else if (patch.providers !== undefined) next.providers = patch.providers;
      return next;
    });
    return this.summarize(next);
  }

  /** Delete a section. Refuses (409) while it still has lessons. */
  deleteSection(id: string): void {
    this.section(id);
    try { this.journal.deleteSection(id); }
    catch (error) {
      if (error instanceof SectionNotEmptyError) throw new HttpError(409, error.message);
      throw error;
    }
  }

  // ── lessons ──────────────────────────────────────────────────────────────

  private ensureDerived(id: string): void {
    let version = 0;
    try {
      version = (JSON.parse(readFileSync(this.journal.sectionPath(id, '_derived', 'format.json'), 'utf8')) as { version?: number }).version ?? 0;
    } catch {
      // A missing or malformed marker belongs to an older derived format.
    }
    if (version !== DERIVED_FORMAT_VERSION || !existsSync(this.journal.sectionPath(id, '_derived', 'meta.json'))) this.journal.writeDerived(id);
  }

  lessonMetas(id: string): LessonMetaT[] {
    this.section(id);
    this.ensureDerived(id);
    const raw = JSON.parse(readFileSync(this.journal.sectionPath(id, '_derived', 'meta.json'), 'utf8')) as unknown[];
    return raw.map((m) => LessonMeta.parse(m));
  }

  private lessonFileFor(id: string, slug: string): string | null {
    for (const f of this.journal.lessonFiles(id)) {
      try {
        const raw = JSON.parse(readFileSync(this.journal.sectionPath(id, f), 'utf8')) as { slug?: unknown };
        if (raw.slug === slug) return this.journal.sectionPath(id, f);
      } catch {
        // malformed: reported by writeDerived
      }
    }
    return null;
  }

  lesson(id: string, slug: string): LessonT {
    this.section(id);
    const path = this.lessonFileFor(id, slug);
    if (!path) throw new HttpError(404, `No lesson "${slug}" in section "${id}"`);
    try { return readStoredLesson(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) { throw new HttpError(500, `Lesson "${slug}" is malformed: ${(error as Error).message}`); }
  }

  /** POST creates; only an explicit PUT or import replacement may overwrite. */
  saveLesson(id: string, input: unknown, mode: 'create' | 'replace' = 'create'): LessonT {
    this.section(id);
    const parsed = Lesson.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid lesson', parsed.error.format());
    const lesson = parsed.data;
    const stem = lessonFileStem(lesson);
    lesson.id = stem;
    const existing = this.lessonFileFor(id, lesson.slug);
    if (existing && !existing.endsWith(`${stem}.json`)) {
      throw new HttpError(409, `Slug "${lesson.slug}" is already used by another lesson (${existing})`);
    }
    try { return this.journal.writeLesson(id, lesson, mode); }
    catch (error) {
      if (error instanceof LessonConflictError) throw new HttpError(409, error.message);
      throw error;
    }
  }

  exportLesson(id: string, slug: string): { filename: string; data: Buffer } {
    const lesson = this.lesson(id, slug);
    return {
      filename: `${lesson.id}.json`,
      data: Buffer.from(`${JSON.stringify(lesson, null, 2)}\n`, 'utf8'),
    };
  }

  importLesson(id: string, input: unknown): LessonImportResult {
    this.section(id);
    const parsed = LessonImportInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid lesson import', parsed.error.format());
    const incoming = Lesson.safeParse(parsed.data.lesson);
    if (!incoming.success) throw new HttpError(400, 'Invalid lesson', incoming.error.format());
    return this.journal.commit(() => {
      const section = this.section(id);
      const existing = this.journal.readSectionLessons(id).map((entry) => entry.lesson);
      const plan = planImport(existing, [incoming.data], parsed.data.conflict, new JournalProgress(this.journal).readForImport(id));
      if (plan.conflicts.length && parsed.data.conflict === 'error') {
        throw new HttpError(409, `Lesson "${incoming.data.slug}" already exists`, { conflicts: plan.conflicts });
      }
      return {
        changes: sectionWriteChanges(section, plan.lessons, plan.results.map((r) => r.lesson), plan.removed),
        result: plan.results[0],
      };
    });
  }

  deleteLesson(id: string, slug: string): void {
    this.journal.commit(() => {
      const section = this.section(id);
      const existing = this.journal.readSectionLessons(id).map((entry) => entry.lesson);
      const removed = existing.find((lesson) => lesson.slug === slug);
      if (!removed) throw new HttpError(404, `No lesson "${slug}" in section "${id}"`);
      return { changes: sectionWriteChanges(section, existing.filter((lesson) => lesson.slug !== slug), [], [removed]), result: undefined };
    });
  }

  exportSection(id: string, includeProgress: boolean): { filename: string; data: Buffer } {
    const section = structuredClone(this.section(id));
    const lessons = this.journal.readSectionLessons(id).map((entry) => entry.lesson);
    const topicsPath = this.journal.topicsPath(id);
    const backdropPath = this.backdropPath(id);
    if (section.theme?.backdrop && !backdropPath) {
      delete section.theme.backdrop;
      if (Object.keys(section.theme).length === 0) delete section.theme;
    }
    const data = buildSectionArchive({
      section,
      lessons,
      cheatsheet: existsSync(this.journal.cheatsheetPath(id)) ? this.cheatsheet(id) : undefined,
      topics: existsSync(topicsPath) ? this.journal.readTopicCatalog(id) : undefined,
      progress: includeProgress ? this.progress(id) : undefined,
      backdrop: backdropPath ? { name: basename(backdropPath), data: readFileSync(backdropPath) } : undefined,
    });
    return { filename: `${id}.hornbook.zip`, data };
  }

  importSection(input: unknown): SectionImportResult {
    const parsed = SectionImportInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid pair import', parsed.error.format());
    const archiveBytes = Buffer.from(parsed.data.base64, 'base64');
    if (archiveBytes.length > MAX_SECTION_ARCHIVE_BYTES) throw new HttpError(413, 'Pair archive is too large');
    let archive: ReturnType<typeof readSectionArchive>;
    try {
      archive = readSectionArchive(archiveBytes);
    } catch (error) {
      throw new HttpError(400, `Invalid pair archive: ${(error as Error).message}`);
    }
    return this.journal.commit(() => {
      const config = this.journal.loadJournalConfig();
      const section = archive.section;
      const id = section.id;
      const existing = config.sections.find((s) => s.id === id);
      if (existing && (existing.target !== section.target || existing.learner !== section.learner)) {
        throw new HttpError(409, `Pair "${id}" uses different languages in this journal`);
      }
      const lessons = existing ? this.journal.readSectionLessons(id).map((entry) => entry.lesson) : [];
      const plan = planImport(lessons, archive.lessons, parsed.data.conflict, new JournalProgress(this.journal).readForImport(id), archive.progress);
      if (plan.conflicts.length && parsed.data.conflict === 'error') {
        throw new HttpError(409, `${plan.conflicts.length} imported lessons already exist`, { conflicts: plan.conflicts });
      }
      const changes: FileChange[] = sectionWriteChanges(existing ?? section, plan.lessons, plan.results.map((r) => r.lesson), plan.removed);
      if (!existing) {
        changes.push({ path: 'journal.config.json', data: JSON.stringify({ ...config, sections: [...config.sections, section] }, null, 2) + '\n' });
        if (archive.cheatsheet) {
          const sheet = structuredClone(archive.cheatsheet);
          sheet.processed_lessons = sheet.processed_lessons.map(plan.mapSlug);
          for (const category of sheet.categories) for (const entry of category.sections) entry.source_lessons = entry.source_lessons.map(plan.mapSlug);
          changes.push({ path: `${id}/_cheatsheet.json`, data: JSON.stringify(sheet, null, 2) + '\n' });
        }
        if (archive.topics) changes.push({ path: `${id}/_topics.json`, data: JSON.stringify(archive.topics, null, 2) + '\n' });
        if (archive.backdrop) changes.push({ path: `${id}/${archive.backdrop.name}`, data: archive.backdrop.data });
      }
      if (archive.progress) {
        const imported = archive.progress;
        try {
          const progress = new JournalProgress(this.journal).planWrite(id, (current) =>
            mergeImportProgress(current, imported, plan),
          );
          changes.push(...progress.changes);
        } catch (error) {
          if (error instanceof ProgressError) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
      const savedSection = existing ?? section;
      return { changes, result: {
        section: { ...savedSection, label: sectionTitle(savedSection), flags: { target: languageFlag(savedSection.target), learner: languageFlag(savedSection.learner) }, lessonCount: plan.lessons.length },
        created: !existing,
        imported: plan.results.filter((r) => r.action === 'imported').length,
        keptBoth: plan.results.filter((r) => r.action === 'kept-both').length,
        replaced: plan.results.filter((r) => r.action === 'replaced').length,
        progressImported: archive.progress !== undefined,
      } };
    });
  }

  /** Raw JSON text of a derived file, served as-is. */
  derived(id: string, kind: DerivedKind): string {
    this.section(id);
    this.ensureDerived(id);
    return readFileSync(this.journal.sectionPath(id, '_derived', `${kind}.json`), 'utf8');
  }

  cheatsheet(id: string): CheatsheetT {
    this.section(id);
    const path = this.journal.cheatsheetPath(id);
    if (!existsSync(path)) return { processed_lessons: [], categories: [] };
    const result = Cheatsheet.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success) throw new HttpError(500, 'Cheat sheet is malformed', result.error.format());
    return result.data;
  }

  // ── progress ─────────────────────────────────────────────────────────────

  progressView(id: string): ProgressView {
    this.section(id);
    return new JournalProgress(this.journal).read(id);
  }

  progress(id: string): ProgressT {
    const { revision: _revision, journalKey: _key, recovery, ...value } = this.progressView(id);
    if (recovery) throw new HttpError(409, 'Progress needs explicit recovery', { recovery });
    return value;
  }

  saveProgress(id: string, input: unknown, revision?: string, recover = false): ProgressView {
    this.section(id);
    try { return new JournalProgress(this.journal).write(id, input, revision, recover); }
    catch (error) {
      if (error instanceof ProgressError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  // ── backdrop image ───────────────────────────────────────────────────────

  /** Absolute path of a section's backdrop image, or null when it has none. */
  backdropPath(id: string): string | null {
    const section = this.section(id);
    const name = section.theme?.backdrop;
    if (!name) return null;
    // The name is written by saveBackdrop and always a bare file name; guard
    // anyway so a hand-edited config cannot read outside the section folder.
    if (name.includes('/') || name.includes(BS) || name.startsWith('.')) return null;
    const path = this.journal.sectionPath(id, name);
    return existsSync(path) ? path : null;
  }

  /**
   * Store an uploaded image as the section's backdrop, replacing any
   * previous one. Returns the section with the new theme.
   */
  saveBackdrop(id: string, input: unknown): SectionSummary {
    this.section(id);
    const parsed = BackdropInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid image', parsed.error.format());
    const { filename, base64 } = parsed.data;
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(filename)?.[1] ?? 'jpg').toLowerCase();
    if (!BACKDROP_EXTENSIONS.has(ext)) {
      throw new HttpError(400, `Unsupported image type ".${ext}" (use ${[...BACKDROP_EXTENSIONS].join(', ')})`);
    }
    const data = Buffer.from(base64, 'base64');
    if (data.length === 0) throw new HttpError(400, 'Image is empty');
    if (data.length > MAX_BACKDROP_BYTES) {
      throw new HttpError(413, `Image is larger than ${Math.round(MAX_BACKDROP_BYTES / 1024 / 1024)} MB`);
    }
    return this.summarize(this.journal.writeBackdrop(id, { name: `_backdrop.${ext}`, data }));
  }

  /** Remove the backdrop image and the reference to it. */
  deleteBackdrop(id: string): SectionSummary {
    this.section(id);
    return this.summarize(this.journal.writeBackdrop(id, null));
  }

  // ── settings ─────────────────────────────────────────────────────────────

  settings(): SettingsView {
    this.journal.invalidateConfig();
    return {
      providers: this.journal.loadJournalConfig().providers,
      connections: connectionViews(this.journal.journalDir()),
    };
  }

  updateSettings(input: unknown): SettingsView {
    const parsed = SettingsUpdateInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid settings', parsed.error.format());
    this.journal.commit(() => {
      const changes: FileChange[] = [];
      if (parsed.data.providers) changes.push({ path: 'journal.config.json', data: JSON.stringify({ ...this.journal.loadJournalConfig(), providers: parsed.data.providers }, null, 2) + '\n' });
      if (parsed.data.connections) changes.push(planSecretsUpdate(this.dir, parsed.data.connections).change);
      return { changes, result: undefined };
    });
    return this.settings();
  }

  async probe(input: unknown): Promise<ProbeResult> {
    try {
      return await probePipeline(parseProbeInput(input), this.journal.journalDir());
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  /** Files of a section dir, for diagnostics. */
  listFiles(id: string): string[] {
    this.section(id);
    const dir = this.journal.sectionDir(id);
    return existsSync(dir) ? readdirSync(dir) : [];
  }
}
