import { Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  DownloadPlan,
  JobView,
  SetupPlanRequest,
  SetupView,
  ToolId,
  ToolStatus,
  WhisperVariant,
  SettingsView,
  ProbeResult,
  ConnectionKey,
} from '../../lib/api-types';
import type { ProvidersT } from '../../lib/journal-config';
import { TPipe } from '../i18n.pipe';
import { ApiService } from '../api.service';
import { JobsService } from '../jobs.service';
import { JournalService } from '../journal.service';
import { I18nService } from '../i18n.service';

/** What a tool's row is doing right now. A plan is shown before anything is fetched. */
interface RowState {
  phase: 'idle' | 'planning' | 'ready' | 'running' | 'done' | 'failed';
  plan?: DownloadPlan;
  error?: string;
  jobId?: string;
  path?: string;
}

export const TOOL_ORDER: readonly ToolId[] = ['ffmpeg', 'whisper', 'whisper-model', 'ollama', 'ollama-model'];

function idleRows(): Record<ToolId, RowState> {
  return Object.fromEntries(TOOL_ORDER.map((id) => [id, { phase: 'idle' }])) as Record<ToolId, RowState>;
}

/**
 * Setup inside the app: the five local tools of the zero-cost path, each
 * with a status, a download that is planned (source, size, checksum) before
 * it starts, or the terminal line for people who prefer their package
 * manager. One button does the missing ones in order.
 */
@Component({
  selector: 'app-local-setup',
  imports: [FormsModule, TPipe],
  templateUrl: './local-setup.component.html',
})
export class LocalSetupComponent {
  private readonly api = inject(ApiService);
  private readonly jobs = inject(JobsService);
  private readonly journal = inject(JournalService);
  private readonly i18n = inject(I18nService);
  private readonly destroyRef = inject(DestroyRef);
  readonly activated = output<SettingsView>();
  protected readonly activating = signal(false);
  protected readonly verified = signal(false);

  protected readonly order = TOOL_ORDER;
  protected readonly view = signal<SetupView | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rows = signal<Record<ToolId, RowState>>(idleRows());
  protected readonly showCommand = signal<Partial<Record<ToolId, boolean>>>({});

  protected readonly whisperModel = signal('small');
  protected readonly whisperVariant = signal<WhisperVariant>('cpu');
  protected readonly ollamaModel = signal('qwen2.5:7b');
  private choicesSeeded = false;

  protected readonly allRunning = signal(false);
  protected readonly allStep = signal<ToolId | null>(null);
  protected readonly allDone = signal(false);
  protected readonly ollamaStarting = signal(false);
  protected readonly ollamaNote = signal<string | null>(null);

  protected readonly setupJob = this.jobs.setupJob;

  protected readonly missing = computed<ToolId[]>(() => {
    const v = this.view();
    if (!v) return [];
    return this.order.filter((id) => {
      const tool = v.tools.find((candidate) => candidate.id === id);
      return !tool?.installed || !!tool.update;
    });
  });
  protected readonly ready = computed(() => !!this.view() && this.missing().length === 0);
  protected readonly cudaOffered = computed(() => {
    const v = this.view();
    return !!v && v.platform === 'win32' && v.machine.arch === 'x64';
  });
  protected readonly gpuLabel = computed(() => this.view()?.machine.gpu?.name ?? null);
  protected readonly ramGb = computed(() => Math.round((this.view()?.machine.ramMb ?? 0) / 1024));

  constructor() {
    void this.load();
  }

  protected status(id: ToolId): ToolStatus | undefined {
    return this.view()?.tools.find((t) => t.id === id);
  }

  protected row(id: ToolId): RowState {
    return this.rows()[id];
  }

  protected isModelRow(id: ToolId): boolean {
    return id === 'whisper-model' || id === 'ollama-model';
  }

  /** Progress of the job this row started, while it runs. */
  protected progress(id: ToolId): { pct: number; stage: string } | null {
    const job = this.setupJob();
    const r = this.row(id);
    if (!job || r.phase !== 'running' || job.id !== r.jobId) return null;
    return { pct: job.progress?.pct ?? 0, stage: job.progress?.stage ?? (job.status === 'queued' ? 'queued' : 'starting') };
  }

  protected fmt(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 2)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.round(bytes / 1e3)} kB`;
  }

  protected shortSha(sha: string | undefined): string {
    return sha ? `${sha.slice(0, 8)}…${sha.slice(-4)}` : '';
  }

  protected toggleCommand(id: ToolId): void {
    this.showCommand.update((s) => ({ ...s, [id]: !s[id] }));
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const v = await this.api.get<SetupView>('/api/setup');
      this.view.set(v);
      if (!this.choicesSeeded) {
        this.whisperModel.set(v.recommend.whisperModel);
        this.whisperVariant.set(v.recommend.whisperVariant);
        this.ollamaModel.set(v.recommend.ollamaModel);
        this.choicesSeeded = true;
      }
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  private request(id: ToolId): SetupPlanRequest {
    switch (id) {
      case 'whisper':
        return { tool: id, variant: this.cudaOffered() ? this.whisperVariant() : 'cpu' };
      case 'whisper-model':
        return { tool: id, model: this.whisperModel() };
      case 'ollama-model':
        return { tool: id, model: this.ollamaModel() };
      default:
        return { tool: id };
    }
  }

  private setRow(id: ToolId, state: RowState): void {
    this.rows.update((rows) => ({ ...rows, [id]: state }));
  }

  /** Resolve the pinned release and show source, size and checksum. Nothing is fetched yet. */
  protected async prepare(id: ToolId): Promise<boolean> {
    this.setRow(id, { phase: 'planning' });
    try {
      const plan = await this.api.post<DownloadPlan>('/api/setup/plan', this.request(id));
      this.setRow(id, { phase: 'ready', plan });
      return true;
    } catch (err) {
      this.setRow(id, { phase: 'failed', error: (err as Error).message });
      return false;
    }
  }

  protected cancel(id: ToolId): void {
    this.setRow(id, { phase: 'idle' });
  }

  /** Start the download the plan described, follow it, and refresh the statuses when it ends. */
  protected async download(id: ToolId): Promise<boolean> {
    const plan = this.row(id).plan;
    this.setRow(id, { phase: 'running', plan });
    let job: JobView;
    try {
      job = await this.jobs.runSetup(this.request(id), (started) => this.setRow(id, { phase: 'running', plan, jobId: started.id }));
    } catch (err) {
      this.setRow(id, { phase: 'failed', plan, error: (err as Error).message });
      return false;
    }
    if (job.status === 'done') {
      this.setRow(id, { phase: 'done', plan, path: job.result?.path });
    } else {
      this.setRow(id, { phase: 'failed', plan, error: job.error ?? 'failed' });
    }
    await this.load();
    return job.status === 'done';
  }

  /** The missing tools, in order, each planned and then fetched. Stops at the first failure. */
  protected async setupAll(): Promise<void> {
    if (this.allRunning()) return;
    this.allRunning.set(true);
    this.allDone.set(false);
    try {
      for (const id of this.missing()) {
        if (this.destroyRef.destroyed) return;
        if (id === 'ollama-model' && !this.view()?.ollama.running) await this.startOllama();
        this.allStep.set(id);
        if (!(await this.prepare(id))) return;
        if (!(await this.download(id))) return;
      }
      this.allDone.set(this.ready());
      if (!this.destroyRef.destroyed && this.ready()) await this.activate();
    } finally {
      this.allRunning.set(false);
      this.allStep.set(null);
    }
  }

  protected async activate(): Promise<void> {
    if (this.activating() || !this.ready()) return;
    this.activating.set(true);
    this.verified.set(false);
    this.error.set(null);
    try {
      if (!this.view()?.ollama.running) await this.startOllama();
      if (this.destroyRef.destroyed) return;
      const model = this.status('whisper-model')?.path;
      const models = this.status('ollama-model')?.models ?? [];
      const extractModel = models.includes(this.ollamaModel()) ? this.ollamaModel() : models[0];
      if (!model || !extractModel || !this.view()?.ollama.running) throw new Error(this.i18n.t('setup.guide.unavailable'));
      const providers: ProvidersT = { transcribe: { driver: 'whisper-cli', model }, extract: { driver: 'ollama', model: extractModel } };
      const connections: Partial<Record<ConnectionKey, string>> = { OLLAMA_HOST: this.view()!.ollama.host, WHISPER_MODEL: model };
      const whisper = this.status('whisper')?.path;
      const ffmpeg = this.status('ffmpeg')?.path;
      if (whisper) connections.WHISPER_BIN = whisper;
      if (ffmpeg) connections.FFMPEG_BIN = ffmpeg;
      for (const job of ['transcribe', 'extract'] as const) {
        const probe = await this.api.post<ProbeResult>('/api/settings/probe', { job, ...providers[job], connections });
        if (!probe.ok || probe.pick) throw new Error(probe.detail);
        if (this.destroyRef.destroyed) return;
      }
      const settings = await this.api.put<SettingsView>('/api/settings', { providers, connections });
      this.journal.publishProviders(settings.providers);
      if (!this.destroyRef.destroyed) {
        this.verified.set(true);
        this.activated.emit(settings);
      }
    } catch (err) {
      if (!this.destroyRef.destroyed) this.error.set((err as Error).message);
    } finally {
      this.activating.set(false);
    }
  }

  protected async startOllama(): Promise<void> {
    this.ollamaStarting.set(true);
    this.ollamaNote.set(null);
    try {
      const r = await this.api.post<{ running: boolean; detail: string }>('/api/setup/ollama/start', {});
      this.ollamaNote.set(r.detail);
      await this.load();
    } catch (err) {
      this.ollamaNote.set((err as Error).message);
    } finally {
      this.ollamaStarting.set(false);
    }
  }
}
