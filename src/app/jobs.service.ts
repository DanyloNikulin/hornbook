import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import type { JobView, SetupPlanRequest, StartJob } from '../lib/api-types';
import { ApiService } from './api.service';
import { SectionService } from './section.service';
import { I18nService } from './i18n.service';
import { DesktopService } from './desktop.service';

const POLL_MS = 1200;

interface Listener {
  resolve(job: JobView): void;
  reject(error: unknown): void;
  update?: (job: JobView) => void;
  detach(): void;
}
interface Observation {
  id: string;
  listeners: Set<Listener>;
  controller: AbortController;
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
  latest?: JobView;
}

/** Independent observers share one poll per job; observation never cancels server work. */
@Injectable({ providedIn: 'root' })
export class JobsService {
  private readonly api = inject(ApiService);
  private readonly section = inject(SectionService);
  private readonly i18n = inject(I18nService);
  private readonly desktop = inject(DesktopService);

  readonly current = signal<JobView | null>(null);
  /** The setup job being followed (downloads of local tools), apart from lesson jobs. */
  readonly setupJob = signal<JobView | null>(null);
  private readonly observations = new Map<string, Observation>();
  private readonly starts = new Set<AbortController>();
  private readonly notified = new Set<string>();
  private generation = 0;
  private setupGeneration = 0;

  constructor() { inject(DestroyRef).onDestroy(() => this.stop()); }

  async run(input: StartJob, sectionId = this.section.id()): Promise<JobView> {
    const generation = ++this.generation;
    return this.start(`/api/sections/${encodeURIComponent(sectionId)}/${input.kind === 'process' ? 'uploads' : 'jobs'}`, input,
      (job) => { if (generation === this.generation) this.current.set(job); });
  }

  async runSetup(input: SetupPlanRequest & { sha256?: string }, onStarted?: (job: JobView) => void): Promise<JobView> {
    const generation = ++this.setupGeneration;
    return this.start('/api/setup/jobs', input,
      (job) => { if (generation === this.setupGeneration) this.setupJob.set(job); }, onStarted);
  }

  private async start(path: string, input: unknown, update: (job: JobView) => void, onStarted?: (job: JobView) => void): Promise<JobView> {
    const controller = new AbortController();
    this.starts.add(controller);
    this.prepareNotifications();
    try {
      const started = await this.api.post<JobView>(path, input, controller.signal);
      controller.signal.throwIfAborted();
      update(started);
      onStarted?.(started);
      return await this.observe(started.id, update, controller.signal);
    } finally { this.starts.delete(controller); }
  }

  recent(): Promise<JobView[]> { return this.api.get<JobView[]>(`${this.section.apiBase()}/jobs`); }

  /** Release all local observations. Jobs remain queued/running on the server. */
  stop(): void {
    this.generation++; this.setupGeneration++;
    for (const controller of this.starts) controller.abort();
    for (const observation of this.observations.values()) this.settle(observation, undefined, new DOMException('Observation stopped', 'AbortError'));
  }

  observe(id: string, update?: (job: JobView) => void, signal?: AbortSignal): Promise<JobView> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let observation = this.observations.get(id);
    const fresh = !observation;
    if (!observation) {
      observation = { id, listeners: new Set(), controller: new AbortController(), active: true };
      this.observations.set(id, observation);
    }
    const selected = observation;
    const promise = new Promise<JobView>((resolve, reject) => {
      const cancel = () => {
        selected.listeners.delete(listener); listener.detach(); reject(signal?.reason);
        if (selected.listeners.size === 0) this.release(selected);
      };
      const listener: Listener = { resolve, reject, update, detach: () => signal?.removeEventListener('abort', cancel) };
      selected.listeners.add(listener);
      signal?.addEventListener('abort', cancel, { once: true });
      if (selected.latest) update?.(selected.latest);
    });
    if (fresh) void this.tick(selected);
    return promise;
  }

  private async tick(observation: Observation): Promise<void> {
    try {
      const job = await this.api.get<JobView>(`/api/jobs/${encodeURIComponent(observation.id)}`,
        AbortSignal.any([observation.controller.signal, AbortSignal.timeout(30_000)]));
      if (!observation.active) return;
      observation.latest = job;
      for (const listener of observation.listeners) listener.update?.(job);
      if (!observation.active) return;
      if (job.status === 'done' || job.status === 'failed') {
        if (!this.notified.has(job.id)) {
          this.notified.add(job.id);
          if (this.notified.size > 50) this.notified.delete(this.notified.values().next().value!);
          this.notify(job);
        }
        this.settle(observation, job);
      } else observation.timer = setTimeout(() => { void this.tick(observation); }, POLL_MS);
    } catch (error) {
      if (observation.active) this.settle(observation, undefined, error);
    }
  }

  private settle(observation: Observation, job?: JobView, error?: unknown): void {
    this.release(observation);
    for (const listener of observation.listeners) {
      listener.detach();
      if (job) listener.resolve(job); else listener.reject(error);
    }
    observation.listeners.clear();
  }

  private release(observation: Observation): void {
    observation.active = false;
    clearTimeout(observation.timer);
    observation.controller.abort();
    if (this.observations.get(observation.id) === observation) this.observations.delete(observation.id);
  }

  private prepareNotifications(): void {
    if (this.desktop.available()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    void Notification.requestPermission().catch(() => undefined);
  }

  private notify(job: JobView): void {
    if (this.desktop.available()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
    try {
      const bodyKey = job.status === 'done' ? 'job.notificationDone' : 'job.notificationFailed';
      new Notification(this.i18n.t('job.notificationTitle'), {
        body: this.i18n.t(bodyKey, { label: job.label }),
        tag: `hornbook-job-${job.id}`,
      });
    } catch {
      // Notifications are a convenience; job completion must never depend on them.
    }
  }
}
