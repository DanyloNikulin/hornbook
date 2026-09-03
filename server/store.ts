// FolderStore: every read and write the API does against the journal folder.
// Thin on purpose — the layout lives in scripts/lib/journal.ts, validation in
// src/lib/schema.ts, derived data in scripts/lib/derived.ts. This class adds
// the HTTP-facing rules (404/409) and keeps derived files fresh on writes.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import type { SectionSummary, ConfigView } from '../src/lib/api-types.ts';
import * as journal from '../scripts/lib/journal.ts';
import { lessonToMarkdown } from '../scripts/lib/markdown.ts';
import { z } from 'zod';

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
    transcribe: { driver: 'whisper-cli', model: 'base' },
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

const ProcessInput = z.object({
  filename: z.string().min(1),
  base64: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  from: z.enum(['video', 'audio', 'transcript', 'json']).optional(),
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
    if (!existsSync(join(journal.derivedDir(id), 'meta.json'))) journal.writeDerived(id);
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
    const dir = journal.sectionDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stem}.json`), JSON.stringify(lesson, null, 2) + '\n', 'utf8');
    writeFileSync(join(dir, `${stem}.md`), lessonToMarkdown(lesson), 'utf8');
    this.rebuild(id);
    return lesson;
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
    return result.data;
  }

  saveProgress(id: string, input: unknown): ProgressT {
    this.section(id);
    const result = Progress.safeParse(input);
    if (!result.success) throw new HttpError(400, 'Invalid progress', result.error.format());
    mkdirSync(journal.sectionDir(id), { recursive: true });
    writeFileSync(journal.progressPath(id), JSON.stringify(result.data, null, 2) + '\n', 'utf8');
    return result.data;
  }

  // ── pipeline ─────────────────────────────────────────────────────────────

  /**
   * Run scripts/process.ts on an uploaded file. Synchronous from the API's
   * point of view (the request waits); the job queue with progress arrives
   * with phase 6.
   */
  async processFile(id: string, input: unknown): Promise<{ ok: boolean; log: string }> {
    this.section(id);
    const parsed = ProcessInput.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid process request', parsed.error.format());
    const { filename, base64, date, from } = parsed.data;
    const ext = extname(filename).toLowerCase() || '.bin';
    const tmp = join(tmpdir(), `hornbook-${randomBytes(6).toString('hex')}${ext}`);
    writeFileSync(tmp, Buffer.from(base64, 'base64'));
    const args = [
      '--import',
      'tsx',
      join(journal.repoRootDir(), 'scripts', 'process.ts'),
      tmp,
      '--date',
      date,
      '--section',
      id,
      ...(from ? ['--from', from] : []),
    ];
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: journal.repoRootDir(),
        env: { ...process.env, HORNBOOK_JOURNAL: journal.journalDir() },
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.stderr.on('data', (c: Buffer) => (out += c.toString()));
      child.on('close', (code) => {
        rmSync(tmp, { force: true });
        resolve({ ok: code === 0, log: out.slice(-8000) });
      });
    });
  }

  /** Files of a section dir, for diagnostics. */
  listFiles(id: string): string[] {
    this.section(id);
    const dir = journal.sectionDir(id);
    return existsSync(dir) ? readdirSync(dir) : [];
  }
}
