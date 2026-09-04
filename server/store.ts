// FolderStore: every read and write the API does against the journal folder.
// Thin on purpose — the layout lives in scripts/lib/journal.ts, validation in
// src/lib/schema.ts, derived data in scripts/lib/derived.ts. This class adds
// the HTTP-facing rules (404/409) and keeps derived files fresh on writes.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  Cheatsheet,
  EMPTY_PROGRESS,
  Lesson,
  LessonMeta,
  Progress,
  type CheatsheetT,
  type LessonMetaT,
  type LessonT,
  type ProgressT,
  type DerivedCardT,
  type TopicCatalogT,
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
  type ImportConflictStrategy,
  type LessonImportConflict,
  type LessonImportResult,
  type SectionImportResult,
} from '../src/lib/api-types.ts';
import { connectionViews, updateSecrets } from './secrets.ts';
import { parseProbeInput, probePipeline } from './probe.ts';
import * as journal from '../scripts/lib/journal.ts';
import { lessonToMarkdown } from '../scripts/lib/markdown.ts';
import { z } from 'zod';
import { remapLessonScopedId } from '../src/lib/content-ids.ts';
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
  constructor(journalDir?: string) {
    if (journalDir) journal.setJournalDir(journalDir);
    this.ensureJournal();
  }

  get dir(): string {
    return journal.journalDir();
  }

  /** A missing journal is created with defaults and no sections. */
  private ensureJournal(): void {
    if (!existsSync(journal.configPath())) {
      journal.saveJournalConfig(DEFAULT_CONFIG);
    }
  }

  // ── config & sections ────────────────────────────────────────────────────

  config(): ConfigView {
    journal.invalidateConfig();
    const c = journal.loadJournalConfig();
    return { brand: c.brand, providers: c.providers, sections: c.sections.map((s) => this.summarize(s)) };
  }

  private summarize(s: SectionConfigT): SectionSummary {
    return {
      ...s,
      label: sectionTitle(s),
      flags: { target: languageFlag(s.target), learner: languageFlag(s.learner) },
      lessonCount: journal.lessonFiles(s.id).length,
    };
  }

  section(id: string): SectionConfigT {
    journal.invalidateConfig();
    const s = journal.listSections().find((x) => x.id === id);
    if (!s) throw new HttpError(404, `Unknown section "${id}"`);
    return s;
  }

  createSection(input: unknown): SectionSummary {
    const parsed = CreateSectionInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid section', parsed.error.format());
    const { target, learner, title, id } = parsed.data;
    if (target === learner) throw new HttpError(400, 'Target and learner language must differ');
    journal.invalidateConfig();
    const wantId = id ?? sectionIdFor(target, learner);
    if (journal.listSections().some((s) => s.id === wantId)) {
      throw new HttpError(409, `Section "${wantId}" already exists`);
    }
    const created = journal.createSection({ target, learner, title, id: wantId });
    return this.summarize(created);
  }

  updateSection(id: string, input: unknown): SectionSummary {
    const parsed = UpdateSectionInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid section update', parsed.error.format());
    const current = this.section(id);
    const next: SectionConfigT = { ...current };
    const p = parsed.data;
    if (p.title !== undefined) {
      if (p.title === null) delete next.title;
      else next.title = p.title;
    }
    if (p.theme !== undefined) {
      if (p.theme === null) delete next.theme;
      else next.theme = p.theme;
    }
    if (p.providers !== undefined) {
      if (p.providers === null) delete next.providers;
      else next.providers = p.providers;
    }
    const config = journal.loadJournalConfig();
    journal.saveJournalConfig({
      ...config,
      sections: config.sections.map((s) => (s.id === id ? next : s)),
    });
    return this.summarize(next);
  }

  /** Delete a section. Refuses (409) while it still has lessons. */
  deleteSection(id: string): void {
    this.section(id);
    if (journal.lessonFiles(id).length > 0) {
      throw new HttpError(409, `Section "${id}" still has lessons; delete them first`);
    }
    const config = journal.loadJournalConfig();
    journal.saveJournalConfig({ ...config, sections: config.sections.filter((s) => s.id !== id) });
    rmSync(journal.sectionDir(id), { recursive: true, force: true });
  }

  // ── lessons ──────────────────────────────────────────────────────────────

  private ensureDerived(id: string): void {
    const dir = journal.derivedDir(id);
    let version = 0;
    try {
      version = (JSON.parse(readFileSync(join(dir, 'format.json'), 'utf8')) as { version?: number }).version ?? 0;
    } catch {
      // A missing or malformed marker belongs to an older derived format.
    }
    if (version !== journal.DERIVED_FORMAT_VERSION || !existsSync(join(dir, 'meta.json'))) journal.writeDerived(id);
  }

  lessonMetas(id: string): LessonMetaT[] {
    this.section(id);
    this.ensureDerived(id);
    const raw = JSON.parse(readFileSync(join(journal.derivedDir(id), 'meta.json'), 'utf8')) as unknown[];
    return raw.map((m) => LessonMeta.parse(m));
  }

  private lessonFileFor(id: string, slug: string): string | null {
    const dir = journal.sectionDir(id);
    for (const f of journal.lessonFiles(id)) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { slug?: unknown };
        if (raw.slug === slug) return join(dir, f);
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
    const result = Lesson.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success) throw new HttpError(500, `Lesson "${slug}" is malformed`, result.error.format());
    return result.data;
  }

  /**
   * Create or replace a lesson. The file is `<date>-<slug>.json`; a slug that
   * already belongs to a lesson with a different date is a conflict (routes
   * key by slug alone).
   */
  saveLesson(id: string, input: unknown): LessonT {
    this.section(id);
    const parsed = Lesson.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid lesson', parsed.error.format());
    const lesson = parsed.data;
    const stem = journal.lessonFileStem(lesson);
    lesson.id = stem;
    const existing = this.lessonFileFor(id, lesson.slug);
    if (existing && !existing.endsWith(`${stem}.json`)) {
      throw new HttpError(409, `Slug "${lesson.slug}" is already used by another lesson (${existing})`);
    }
    this.writeLessonFiles(id, lesson);
    this.rebuild(id);
    return lesson;
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
    return this.importOneLesson(id, incoming.data, parsed.data.conflict, true);
  }

  deleteLesson(id: string, slug: string): void {
    this.section(id);
    const path = this.lessonFileFor(id, slug);
    if (!path) throw new HttpError(404, `No lesson "${slug}" in section "${id}"`);
    rmSync(path, { force: true });
    rmSync(path.replace(/\.json$/, '.md'), { force: true });
    this.rebuild(id);
  }

  private rebuild(id: string): void {
    try {
      journal.writeDerived(id);
    } catch (err) {
      throw new HttpError(500, `Derived data rebuild failed: ${(err as Error).message}`);
    }
  }

  private writeLessonFiles(id: string, lesson: LessonT): void {
    const stem = journal.lessonFileStem(lesson);
    const dir = journal.sectionDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stem}.json`), `${JSON.stringify(lesson, null, 2)}\n`, 'utf8');
    writeFileSync(join(dir, `${stem}.md`), lessonToMarkdown(lesson), 'utf8');
  }

  private importOneLesson(
    sectionId: string,
    incoming: LessonT,
    strategy: ImportConflictStrategy,
    rebuild: boolean,
    reserved = new Set<string>(),
  ): LessonImportResult {
    const existingPath = this.lessonFileFor(sectionId, incoming.slug);
    const originalId = incoming.id;
    let lesson = incoming;
    let action: LessonImportResult['action'] = 'imported';
    if (existingPath) {
      const conflict = this.lessonConflict(existingPath, incoming);
      if (strategy === 'error') {
        throw new HttpError(409, `Lesson "${incoming.slug}" already exists`, { conflicts: [conflict] });
      }
      if (strategy === 'keep-both') {
        const slug = this.availableSlug(sectionId, incoming.slug, reserved);
        lesson = Lesson.parse({ ...incoming, slug, id: `${incoming.date}-${slug}` });
        action = 'kept-both';
      } else {
        rmSync(existingPath, { force: true });
        rmSync(existingPath.replace(/\.json$/, '.md'), { force: true });
        action = 'replaced';
      }
    }
    reserved.add(lesson.slug);
    this.writeLessonFiles(sectionId, lesson);
    if (rebuild) this.rebuild(sectionId);
    return { lesson, action, originalId };
  }

  private lessonConflict(existingPath: string, incoming: LessonT): LessonImportConflict {
    const existing = Lesson.parse(JSON.parse(readFileSync(existingPath, 'utf8')));
    return { slug: incoming.slug, incomingId: incoming.id, existingId: existing.id };
  }

  private availableSlug(sectionId: string, base: string, reserved: ReadonlySet<string>): string {
    const used = journal.existingSlugs(sectionId);
    let n = 2;
    while (used.has(`${base}-${n}`) || reserved.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  exportSection(id: string, includeProgress: boolean): { filename: string; data: Buffer } {
    const section = structuredClone(this.section(id));
    const lessons = journal.readSectionLessons(id).map((entry) => entry.lesson);
    const topicsPath = journal.topicsPath(id);
    const backdropPath = this.backdropPath(id);
    if (section.theme?.backdrop && !backdropPath) {
      delete section.theme.backdrop;
      if (Object.keys(section.theme).length === 0) delete section.theme;
    }
    const data = buildSectionArchive({
      section,
      lessons,
      cheatsheet: existsSync(journal.cheatsheetPath(id)) ? this.cheatsheet(id) : undefined,
      topics: existsSync(topicsPath) ? journal.readTopicCatalog(id) : undefined,
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
    const existing = this.config().sections.find((section) => section.id === archive.section.id);
    if (existing && (existing.target !== archive.section.target || existing.learner !== archive.section.learner)) {
      throw new HttpError(409, `Pair "${archive.section.id}" uses different languages in this journal`);
    }

    const conflicts = this.sectionConflicts(archive.section.id, archive.lessons);
    if (conflicts.length > 0 && parsed.data.conflict === 'error') {
      throw new HttpError(409, `${conflicts.length} imported lesson${conflicts.length === 1 ? '' : 's'} already exist`, { conflicts });
    }

    const created = !existing;
    if (created) {
      this.createSection({
        id: archive.section.id,
        target: archive.section.target,
        learner: archive.section.learner,
        title: archive.section.title,
      });
    }
    if (created) this.applyImportedSectionConfig(archive.section);

    const reserved = new Set<string>();
    const results = archive.lessons.map((lesson) =>
      this.importOneLesson(archive.section.id, lesson, parsed.data.conflict, false, reserved),
    );
    if (created) {
      this.writeImportedSectionFiles(archive.section.id, archive.cheatsheet, archive.topics, archive.backdrop);
    }
    this.rebuild(archive.section.id);
    if (archive.progress) this.mergeImportedProgress(archive.section.id, archive.progress, results);
    return {
      section: this.summarize(this.section(archive.section.id)),
      created,
      imported: results.filter((result) => result.action === 'imported').length,
      keptBoth: results.filter((result) => result.action === 'kept-both').length,
      replaced: results.filter((result) => result.action === 'replaced').length,
      progressImported: archive.progress !== undefined,
    };
  }

  private sectionConflicts(sectionId: string, lessons: readonly LessonT[]): LessonImportConflict[] {
    if (!this.config().sections.some((section) => section.id === sectionId)) return [];
    return lessons.flatMap((lesson) => {
      const path = this.lessonFileFor(sectionId, lesson.slug);
      return path ? [this.lessonConflict(path, lesson)] : [];
    });
  }

  private applyImportedSectionConfig(imported: SectionConfigT): void {
    const config = journal.loadJournalConfig();
    journal.saveJournalConfig({
      ...config,
      sections: config.sections.map((section) => (section.id === imported.id ? imported : section)),
    });
  }

  private writeImportedSectionFiles(
    id: string,
    cheatsheet: CheatsheetT | undefined,
    topics: TopicCatalogT | undefined,
    backdrop: { name: string; data: Uint8Array } | undefined,
  ): void {
    if (cheatsheet) writeFileSync(journal.cheatsheetPath(id), `${JSON.stringify(cheatsheet, null, 2)}\n`, 'utf8');
    if (topics) journal.writeTopicCatalog(id, topics);
    this.clearBackdropFiles(id);
    if (backdrop) writeFileSync(join(journal.sectionDir(id), backdrop.name), backdrop.data);
  }

  private mergeImportedProgress(id: string, imported: ProgressT, lessons: readonly LessonImportResult[]): void {
    const current = this.progress(id);
    const remappedSm2: ProgressT['sm2'] = {};
    for (const [key, state] of Object.entries(imported.sm2)) {
      let next = key;
      for (const lesson of lessons) next = remapLessonScopedId(next, lesson.originalId, lesson.lesson.id);
      remappedSm2[next] = state;
    }
    const remappedQuiz: ProgressT['quiz'] = {};
    for (const [slug, result] of Object.entries(imported.quiz)) {
      const lesson = lessons.find((entry) => entry.originalId === `${entry.lesson.date}-${slug}`);
      remappedQuiz[lesson?.lesson.slug ?? slug] = result;
    }
    const activity = { ...current.activity };
    for (const [date, count] of Object.entries(imported.activity)) {
      activity[date] = Math.max(activity[date] ?? 0, count);
    }
    this.saveProgress(id, {
      sm2: { ...current.sm2, ...remappedSm2 },
      daily: newerDaily(current.daily, imported.daily),
      quiz: { ...current.quiz, ...remappedQuiz },
      activity,
    });
  }

  /** Raw JSON text of a derived file, served as-is. */
  derived(id: string, kind: DerivedKind): string {
    this.section(id);
    this.ensureDerived(id);
    return readFileSync(join(journal.derivedDir(id), `${kind}.json`), 'utf8');
  }

  cheatsheet(id: string): CheatsheetT {
    this.section(id);
    const path = journal.cheatsheetPath(id);
    if (!existsSync(path)) return { processed_lessons: [], categories: [] };
    const result = Cheatsheet.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success) throw new HttpError(500, 'Cheat sheet is malformed', result.error.format());
    return result.data;
  }

  // ── progress ─────────────────────────────────────────────────────────────

  progress(id: string): ProgressT {
    this.section(id);
    const path = journal.progressPath(id);
    if (!existsSync(path)) return { ...EMPTY_PROGRESS };
    const result = Progress.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success) {
      // A corrupt progress file must not brick the section. Keep it aside.
      const backup = path.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      writeFileSync(backup, readFileSync(path));
      return { ...EMPTY_PROGRESS };
    }
    const cards = JSON.parse(this.derived(id, 'cards')) as DerivedCardT[];
    const sm2 = { ...result.data.sm2 };
    const migrated = new Set<string>();
    for (const card of cards) {
      for (const alias of [...card.source_ids, ...(card.legacy_id ? [card.legacy_id] : [])]) {
        if (alias === card.id || !sm2[alias]) continue;
        if (!sm2[card.id]) sm2[card.id] = sm2[alias];
        migrated.add(alias);
      }
    }
    for (const legacyId of migrated) delete sm2[legacyId];
    return { ...result.data, sm2 };
  }

  saveProgress(id: string, input: unknown): ProgressT {
    this.section(id);
    const result = Progress.safeParse(input);
    if (!result.success) throw new HttpError(400, 'Invalid progress', result.error.format());
    mkdirSync(journal.sectionDir(id), { recursive: true });
    writeFileSync(journal.progressPath(id), JSON.stringify(result.data, null, 2) + '\n', 'utf8');
    return result.data;
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
    const path = join(journal.sectionDir(id), name);
    return existsSync(path) ? path : null;
  }

  /**
   * Store an uploaded image as the section's backdrop, replacing any
   * previous one. Returns the section with the new theme.
   */
  saveBackdrop(id: string, input: unknown): SectionSummary {
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
    this.clearBackdropFiles(id);
    const name = `_backdrop.${ext}`;
    mkdirSync(journal.sectionDir(id), { recursive: true });
    writeFileSync(join(journal.sectionDir(id), name), data);
    const section = this.section(id);
    return this.updateSection(id, { theme: { ...section.theme, backdrop: name } });
  }

  /** Remove the backdrop image and the reference to it. */
  deleteBackdrop(id: string): SectionSummary {
    const section = this.section(id);
    this.clearBackdropFiles(id);
    const theme = { ...section.theme };
    delete theme.backdrop;
    return this.updateSection(id, { theme: Object.keys(theme).length > 0 ? theme : null });
  }

  private clearBackdropFiles(id: string): void {
    const dir = journal.sectionDir(id);
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (/^_backdrop\./.test(f)) rmSync(join(dir, f), { force: true });
    }
  }

  // ── settings ─────────────────────────────────────────────────────────────

  settings(): SettingsView {
    journal.invalidateConfig();
    return {
      providers: journal.loadJournalConfig().providers,
      connections: connectionViews(journal.journalDir()),
    };
  }

  updateSettings(input: unknown): SettingsView {
    const parsed = SettingsUpdateInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid settings', parsed.error.format());
    if (parsed.data.providers) {
      const config = journal.loadJournalConfig();
      journal.saveJournalConfig({ ...config, providers: parsed.data.providers });
    }
    if (parsed.data.connections) {
      updateSecrets(journal.journalDir(), parsed.data.connections);
    }
    return this.settings();
  }

  async probe(input: unknown): Promise<ProbeResult> {
    try {
      return await probePipeline(parseProbeInput(input), journal.journalDir());
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  /** Files of a section dir, for diagnostics. */
  listFiles(id: string): string[] {
    this.section(id);
    const dir = journal.sectionDir(id);
    return existsSync(dir) ? readdirSync(dir) : [];
  }
}

function newerDaily(a: ProgressT['daily'], b: ProgressT['daily']): ProgressT['daily'] {
  if (!a) return b;
  if (!b) return a;
  if (a.date !== b.date) return a.date > b.date ? a : b;
  return {
    date: a.date,
    target_learner: Math.max(a.target_learner, b.target_learner),
    learner_target: Math.max(a.learner_target, b.learner_target),
    pairs: Math.max(a.pairs, b.pairs),
  };
}
