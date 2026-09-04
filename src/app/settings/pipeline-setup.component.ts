import { Component, computed, DestroyRef, effect, HostListener, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ConnectionKey, ConnectionView, ProbeResult } from '../../lib/api-types';
import {
  OPTIONAL_CONNECTIONS,
  PLACES_FOR,
  adoptPlace,
  cloudDriverFromKey,
  pathFor,
  pathsFor,
  placeFor,
  type PlaceId,
  type PipelineJob,
} from '../../lib/pipeline';
import { TPipe } from '../i18n.pipe';
import { ApiService } from '../api.service';

type CliState = 'checking' | 'installed' | 'missing';

interface CliStatus {
  readonly state: CliState;
  readonly detail: string;
}

const CLI_ENV: Readonly<Record<string, string>> = {
  'claude-cli': 'CLAUDE_BIN',
  'codex-cli': 'CODEX_BIN',
  'grok-cli': 'GROK_BIN',
  'kimi-cli': 'KIMI_BIN',
};

const MODEL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * One of the two pipeline steps. The user picks a place (this computer /
 * home network / internet API). The cloud API is inferred from the key;
 * models come from that connection, never from a Hornbook catalog.
 */
@Component({
  selector: 'app-pipeline-setup',
  imports: [FormsModule, TPipe],
  templateUrl: './pipeline-setup.component.html',
})
export class PipelineSetupComponent {
  private readonly api = inject(ApiService);
  private listTimer: ReturnType<typeof setTimeout> | undefined;

  readonly job = input.required<PipelineJob>();
  readonly config = input.required<{ driver: string; model: string }>();
  readonly showConnections = input(true);
  readonly connections = input<Record<ConnectionKey, ConnectionView> | null>(null);
  readonly draft = input<Record<ConnectionKey, string>>({} as Record<ConnectionKey, string>);

  protected readonly checking = signal(false);
  protected readonly probe = signal<ProbeResult | null>(null);
  protected readonly listedModels = signal<string[]>([]);
  protected readonly modelPickerOpen = signal(false);
  protected readonly modelQuery = signal('');
  protected readonly cloudKey = signal('');
  protected readonly cliStatuses = signal<Readonly<Record<string, CliStatus>>>({});
  protected readonly cliStatusBusy = signal(false);
  private readonly rev = signal(0);
  private cliScanStarted = false;

  protected readonly places = computed(() => PLACES_FOR[this.job()]);
  protected readonly place = computed(() => {
    this.rev();
    return placeFor(this.job(), this.config().driver);
  });
  protected readonly path = computed(() => {
    this.rev();
    return pathFor(this.job(), this.config().driver);
  });
  protected readonly unifiedCloud = computed(
    () => this.job() === 'extract' && this.place() === 'cloud' && this.showConnections(),
  );
  protected readonly extractCli = computed(() => this.job() === 'extract' && this.place() === 'cli');
  protected readonly cliPaths = computed(() => pathsFor(this.job(), 'cli'));
  protected readonly placeNote = computed(() =>
    this.extractCli() ? 'pipeline.place.cliExtractNote' : `pipeline.place.${this.place()}Note`,
  );
  protected readonly listsFromConnection = computed(() => {
    const p = this.place();
    return p === 'lan' || p === 'cloud';
  });
  protected readonly selectedModel = computed(() => {
    this.rev();
    return this.config().model;
  });
  protected readonly listedLabel = computed(() =>
    this.place() === 'cloud' ? 'pipeline.onKey' : 'pipeline.onHost',
  );
  protected readonly sortedModels = computed(() =>
    [...this.listedModels()].sort((a, b) => MODEL_COLLATOR.compare(a, b)),
  );
  protected readonly filteredModels = computed(() => {
    const query = this.modelQuery().trim().toLocaleLowerCase();
    const models = this.sortedModels();
    return query ? models.filter((model) => model.toLocaleLowerCase().includes(query)) : models;
  });
  protected readonly modelListId = computed(() => `pipeline-models-${this.job()}`);
  protected readonly modelHelp = computed(() => {
    const path = this.path();
    if (path?.modelKind === 'file') return 'pipeline.modelFileHelp';
    if (this.place() === 'cli') return 'pipeline.modelCliHelp';
    return this.place() === 'lan' ? 'pipeline.modelLanHelp' : 'pipeline.modelApiHelp';
  });
  protected readonly cloudKeySet = computed(() => {
    const c = this.connections();
    return !!(c?.['ANTHROPIC_API_KEY']?.set || c?.['OPENAI_API_KEY']?.set);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.listTimer));

    // A single scan gives every coding-CLI choice useful status as soon as
    // this place is opened; no CLI is executed by these readiness probes.
    effect(() => {
      if (this.extractCli() && !this.cliScanStarted) {
        this.cliScanStarted = true;
        queueMicrotask(() => void this.refreshCliStatuses());
      }
    });
  }

  protected setPlace(place: PlaceId): void {
    adoptPlace(this.job(), place, this.config());
    this.probe.set(null);
    this.listedModels.set([]);
    this.closeModelPicker();
    this.rev.update((n) => n + 1);
  }

  protected setCliDriver(driver: string): void {
    this.config().driver = driver;
    this.probe.set(null);
    this.listedModels.set([]);
    this.closeModelPicker();
    this.rev.update((n) => n + 1);
  }

  protected pickModel(name: string): void {
    this.config().model = name;
    this.closeModelPicker();
    this.rev.update((n) => n + 1);
  }

  protected onModelInput(value: string): void {
    this.config().model = value;
    this.rev.update((n) => n + 1);
  }

  protected toggleModelPicker(): void {
    const open = !this.modelPickerOpen();
    this.modelPickerOpen.set(open);
    if (open) this.modelQuery.set('');
  }

  protected closeModelPicker(): void {
    this.modelPickerOpen.set(false);
    this.modelQuery.set('');
  }

  protected cliStatus(driver: string): CliStatus | undefined {
    return this.cliStatuses()[driver];
  }

  protected cliUnavailable(driver: string): boolean {
    return this.cliStatus(driver)?.state === 'missing';
  }

  protected cliEnvironment(driver: string): string {
    return CLI_ENV[driver] ?? '';
  }

  protected cliExperimental(driver: string): boolean {
    return driver === 'grok-cli' || driver === 'kimi-cli';
  }

  protected async refreshCliStatuses(): Promise<void> {
    const paths = this.cliPaths();
    this.cliStatusBusy.set(true);
    this.cliStatuses.set(
      Object.fromEntries(paths.map((path) => [path.driver, { state: 'checking', detail: '' }])) as Record<
        string,
        CliStatus
      >,
    );
    const entries = await Promise.all(
      paths.map(async (path): Promise<readonly [string, CliStatus]> => {
        try {
          const result = await this.api.post<ProbeResult>('/api/settings/probe', {
            job: 'extract',
            driver: path.driver,
            model: '-',
          });
          return [
            path.driver,
            { state: result.ok ? 'installed' : 'missing', detail: result.detail },
          ];
        } catch (err) {
          return [path.driver, { state: 'missing', detail: (err as Error).message }];
        }
      }),
    );
    this.cliStatuses.set(Object.fromEntries(entries));
    this.cliStatusBusy.set(false);
  }

  protected onCloudKey(value: string): void {
    this.cloudKey.set(value);
    const inferred = cloudDriverFromKey(value);
    const draft = this.draft();
    if (inferred === 'anthropic') {
      draft['ANTHROPIC_API_KEY'] = value;
      this.config().driver = 'anthropic';
    } else if (inferred === 'openai') {
      draft['OPENAI_API_KEY'] = value;
      this.config().driver = 'openai';
    }
    this.rev.update((n) => n + 1);
    if (value.trim().length >= 16) this.scheduleList();
  }

  protected onDraft(key: ConnectionKey, value: string): void {
    this.draft()[key] = value;
    if (key.endsWith('_KEY') && value.trim().length >= 16) this.scheduleList();
  }

  protected connView(key: ConnectionKey): ConnectionView | undefined {
    return this.connections()?.[key];
  }

  protected optional(key: ConnectionKey): boolean {
    return OPTIONAL_CONNECTIONS.has(key);
  }

  protected async check(): Promise<void> {
    this.checking.set(true);
    this.probe.set(null);
    try {
      this.applyCloudKey();
      const typed: Partial<Record<ConnectionKey, string>> = {};
      const draft = this.draft();
      const path = this.path();
      if (path) {
        for (const key of path.connections) {
          const v = draft[key]?.trim();
          if (v) typed[key] = v;
        }
      }
      const result = await this.api.post<ProbeResult>('/api/settings/probe', {
        job: this.job(),
        driver: this.config().driver,
        model: this.config().model,
        connections: typed,
      });
      this.probe.set(result);
      this.listedModels.set(result.models ?? []);
      this.modelPickerOpen.set((result.models?.length ?? 0) > 0 && !this.config().model);
    } catch (err) {
      this.probe.set({ ok: false, detail: (err as Error).message });
      this.listedModels.set([]);
      this.closeModelPicker();
    } finally {
      this.checking.set(false);
    }
  }

  private scheduleList(): void {
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => {
      if (!this.checking()) void this.check();
    }, 500);
  }

  private applyCloudKey(): void {
    const value = this.cloudKey().trim();
    if (!value) return;
    const inferred = cloudDriverFromKey(value) ?? (this.config().driver === 'anthropic' ? 'anthropic' : 'openai');
    this.config().driver = inferred;
    this.draft()[inferred === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] = value;
    this.rev.update((n) => n + 1);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeModelPicker();
  }
}
