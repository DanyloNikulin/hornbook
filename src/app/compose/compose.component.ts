import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Lesson, type LessonT } from '../../lib/schema';
import type { JobStageView, JobView } from '../../lib/api-types';
import type { ImportConflictStrategy, LessonImportConflict, LessonImportResult } from '../../lib/api-types';
import { LessonsService } from '../lessons.service';
import { VocabService } from '../vocab.service';
import { CardsService } from '../cards.service';
import { SearchService } from '../search.service';
import { providersFor } from '../../lib/journal-config';
import { canHear } from '../../lib/pipeline';
import { SectionService } from '../section.service';
import { JournalService } from '../journal.service';
import { TPipe } from '../i18n.pipe';
import { I18nService } from '../i18n.service';
import { JobsService } from '../jobs.service';
import { ApiError, ApiService, fileToBase64 } from '../api.service';

type From = 'video' | 'audio' | 'transcript' | 'json';
type ComposeMode = 'hand' | 'transcript' | 'recording' | 'import';

const ACCEPTED_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.m4a',
  '.mp3',
  '.wav',
  '.ogg',
  '.opus',
  '.aac',
  '.txt',
  '.vtt',
  '.srt',
]);

@Component({
  selector: 'app-compose',
  imports: [FormsModule, RouterLink, TPipe],
  templateUrl: './compose.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposeComponent {
  protected readonly sec = inject(SectionService);
  private readonly journal = inject(JournalService);
  private readonly lessons = inject(LessonsService);
  private readonly vocab = inject(VocabService);
  private readonly cards = inject(CardsService);
  private readonly search = inject(SearchService);
  private readonly jobs = inject(JobsService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(ApiService);

  protected title = '';
  protected date = new Date().toISOString().slice(0, 10);
  protected summary = '';
  protected article = '';
  protected transcript = '';

  protected readonly error = signal<string | null>(null);
  protected readonly ok = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly activeMode = signal<ComposeMode>('recording');
  protected readonly pickedFile = signal<File | null>(null);
  protected readonly importFile = signal<File | null>(null);
  protected readonly importConflict = signal<LessonImportConflict | null>(null);
  protected readonly dragActive = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly logCopied = signal(false);
  private copyReset: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const clock = setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(clock);
      if (this.copyReset) clearTimeout(this.copyReset);
    });
  }

  protected readonly pickedKind = computed(() => {
    const file = this.pickedFile();
    return file ? inferFrom(file.name) : null;
  });

  protected readonly job = computed(() => this.jobs.current());
  protected readonly jobRunning = computed(() => {
    const j = this.job();
    return j?.status === 'queued' || j?.status === 'running';
  });

  protected readonly providers = computed(() => {
    const section = this.sec.current();
    const cfg = this.journal.config();
    return section ? providersFor(cfg, section) : cfg.providers;
  });

  /** Recording ingest needs a transcribe driver. Text and JSON do not. */
  protected readonly canHear = computed(() => canHear(this.providers().transcribe.driver));

  protected readonly hearingRequired = computed(() => {
    const kind = this.pickedKind();
    return kind === 'audio' || kind === 'video';
  });

  protected readonly startBlocked = computed(() => this.hearingRequired() && !this.canHear());

  protected setMode(mode: ComposeMode): void {
    this.activeMode.set(mode);
    this.error.set(null);
    this.ok.set(null);
  }

  private draft(): LessonT | null {
    const slug =
      this.title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'lesson';
    const parsed = Lesson.safeParse({
      id: `${this.date}-${slug}`,
      date: this.date,
      slug,
      title: this.title.trim() || 'Untitled',
      summary: this.summary.trim() || 'Summary',
      article_md: this.article.trim() || '## Takeaway\n\n',
    });
    if (!parsed.success) {
      this.error.set(this.i18n.t('compose.invalid'));
      return null;
    }
    return parsed.data;
  }

  private invalidate(): void {
    this.vocab.invalidate();
    this.cards.invalidate();
    this.search.invalidate();
  }

  /** Write the lesson into the section folder and open it. */
  protected async save(): Promise<void> {
    this.error.set(null);
    this.ok.set(null);
    const lesson = this.draft();
    if (!lesson) return;
    this.busy.set(true);
    try {
      const saved = await this.lessons.save(lesson);
      this.invalidate();
      await this.router.navigate(this.sec.link('lesson', saved.slug));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  /** Keep a copy outside the journal (share it, or add it elsewhere). */
  protected downloadJson(): void {
    this.error.set(null);
    const lesson = this.draft();
    if (!lesson) return;
    const blob = new Blob([JSON.stringify(lesson, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${lesson.id}.json`;
    a.click();
    this.ok.set(this.i18n.t('compose.downloaded', { name: a.download }));
  }

  /** Pasted transcript → pipeline (extract only). */
  protected async submitTranscript(): Promise<void> {
    const text = this.transcript.trim();
    if (!text) {
      this.error.set(this.i18n.t('compose.pasteFirst'));
      return;
    }
    await this.runProcess('transcript.txt', btoa(unescape(encodeURIComponent(text))), 'transcript');
  }

  /** Choosing a file only prepares the job. Start is deliberately separate. */
  protected onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.selectFile(file);
    input.value = '';
  }

  protected onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    if (!this.busy()) this.dragActive.set(true);
  }

  protected onDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    this.dragActive.set(false);
  }

  protected onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragActive.set(false);
    if (this.busy()) return;
    const file = ev.dataTransfer?.files[0];
    if (file) this.selectFile(file);
  }

  protected cancelFile(): void {
    this.pickedFile.set(null);
    this.error.set(null);
  }

  protected async startFile(): Promise<void> {
    const file = this.pickedFile();
    if (!file) return;
    if (this.startBlocked()) {
      this.error.set(this.i18n.t('compose.hearingBlocked'));
      return;
    }
    this.error.set(null);
    this.ok.set(null);
    this.busy.set(true);
    try {
      const base64 = await fileToBase64(file);
      await this.runProcess(file.name, base64, inferFrom(file.name));
    } catch (err) {
      this.error.set((err as Error).message);
      this.busy.set(false);
    }
  }

  protected onImportFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.importFile.set(file);
      this.importConflict.set(null);
      this.error.set(null);
      this.ok.set(null);
    }
    input.value = '';
  }

  protected clearImportFile(): void {
    this.importFile.set(null);
    this.importConflict.set(null);
    this.error.set(null);
  }

  protected async importLesson(strategy: ImportConflictStrategy = 'error'): Promise<void> {
    const file = this.importFile();
    if (!file || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.ok.set(null);
    try {
      const lesson: unknown = JSON.parse(await file.text());
      const result = await this.api.post<LessonImportResult>(`${this.sec.apiBase()}/lessons/import`, {
        lesson,
        conflict: strategy,
      });
      await this.lessons.reload();
      this.invalidate();
      this.importConflict.set(null);
      await this.router.navigate(this.sec.link('lesson', result.lesson.slug));
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409 ? firstConflict(error.details) : null;
      this.importConflict.set(conflict);
      if (!conflict) this.error.set((error as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected providerName(driver: string): string {
    return providerName(driver);
  }

  protected fileSize(file: File): string {
    return formatBytes(file.size);
  }

  protected saveName(): string {
    return previewSaveName(this.date, this.title, this.i18n.t('compose.saveNamePlaceholder'));
  }

  protected jobElapsed(job: JobView): string {
    return formatJobElapsed(job, this.now());
  }

  protected jobStarted(job: JobView): string {
    const value = job.startedAt ?? job.createdAt;
    return new Intl.DateTimeFormat(this.i18n.locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  protected stageElapsed(stage: JobStageView): string {
    return formatStageElapsed(stage, this.now());
  }

  protected stageProgress(job: JobView): number {
    return processStageProgress(job.stages ?? []);
  }

  protected async copyLog(log: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(log);
      this.logCopied.set(true);
      if (this.copyReset) clearTimeout(this.copyReset);
      this.copyReset = setTimeout(() => this.logCopied.set(false), 1800);
    } catch {
      this.logCopied.set(false);
    }
  }

  private selectFile(file: File): void {
    this.error.set(null);
    this.ok.set(null);
    if (!isAcceptedFile(file.name)) {
      this.pickedFile.set(null);
      this.error.set(this.i18n.t('compose.unsupportedFile'));
      return;
    }
    this.pickedFile.set(file);
  }

  private async runProcess(filename: string, base64: string, from: From): Promise<void> {
    this.error.set(null);
    this.ok.set(null);
    this.busy.set(true);
    try {
      const job: JobView = await this.jobs.run({
        kind: 'process',
        filename,
        base64,
        date: this.date,
        title: this.title.trim() || undefined,
        from,
      });
      if (job.status !== 'done') {
        this.error.set(job.error ?? this.i18n.t('compose.failed'));
        return;
      }
      await this.lessons.reload();
      this.invalidate();
      const slug = job.result?.slug;
      if (slug) {
        await this.router.navigate(this.sec.link('lesson', slug));
      } else {
        this.ok.set(this.i18n.t('compose.added'));
      }
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

export function inferFrom(name: string): From {
  const ext = extensionOf(name);
  if (['.txt', '.vtt', '.srt'].includes(ext)) return 'transcript';
  if (ext === '.json') return 'json';
  if (['.m4a', '.mp3', '.wav', '.ogg', '.opus', '.aac'].includes(ext)) return 'audio';
  return 'video';
}

export function isAcceptedFile(name: string): boolean {
  return ACCEPTED_EXTENSIONS.has(extensionOf(name));
}

export function previewSaveName(date: string, title: string, placeholder = 'title'): string {
  const slug = title
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${date}-${slug || `<${placeholder}>`}.json`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function providerName(driver: string): string {
  const names: Record<string, string> = {
    'whisper-cli': 'whisper.cpp',
    'claude-cli': 'Claude Code',
    'codex-cli': 'Codex CLI',
    'grok-cli': 'Grok CLI',
    'kimi-cli': 'Kimi CLI',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    ollama: 'Ollama',
    skip: '—',
  };
  return names[driver] ?? driver;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.toLowerCase().slice(dot);
}

export function formatJobElapsed(job: Pick<JobView, 'createdAt' | 'startedAt' | 'finishedAt'>, now = Date.now()): string {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return formatDuration(Math.max(0, end - start));
}

function firstConflict(details: unknown): LessonImportConflict | null {
  if (!details || typeof details !== 'object') return null;
  const conflicts = (details as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts) || conflicts.length === 0) return null;
  const first: unknown = conflicts[0];
  if (!first || typeof first !== 'object') return null;
  const value = first as Record<string, unknown>;
  return typeof value['slug'] === 'string' && typeof value['incomingId'] === 'string' && typeof value['existingId'] === 'string'
    ? { slug: value['slug'], incomingId: value['incomingId'], existingId: value['existingId'] }
    : null;
}

export function formatStageElapsed(stage: Pick<JobStageView, 'status' | 'startedAt' | 'finishedAt'>, now = Date.now()): string {
  if (!stage.startedAt || stage.status === 'waiting' || stage.status === 'skipped') return '';
  const start = Date.parse(stage.startedAt);
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : now;
  return formatDuration(Math.max(0, end - start));
}

export function processStageProgress(stages: readonly Pick<JobStageView, 'status'>[]): number {
  if (stages.length === 0) return 0;
  const complete = stages.filter((stage) => stage.status === 'done' || stage.status === 'skipped').length;
  const active = stages.some((stage) => stage.status === 'running') ? 0.5 : 0;
  return Math.round(((complete + active) / stages.length) * 100);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}
