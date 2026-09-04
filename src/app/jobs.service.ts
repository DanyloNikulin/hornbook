import { Injectable, inject, signal, type WritableSignal } from '@angular/core';
import type { JobView, SetupPlanRequest, StartJob } from '../lib/api-types';
import { ApiService } from './api.service';
import { SectionService } from './section.service';

const POLL_MS = 1200;

/**
 * Starts pipeline jobs in the current section and follows one job at a time
 * by polling until it finishes. The UI reads `current()` for status and log.
 */
@Injectable({ providedIn: 'root' })
export class JobsService {
  private readonly api = inject(ApiService);
  private readonly section = inject(SectionService);

  readonly current = signal<JobView | null>(null);
  /** The setup job being followed (downloads of local tools), apart from lesson jobs. */
  readonly setupJob = signal<JobView | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;

  /** Queue a job and follow it. Resolves with the finished job. */
  async run(input: StartJob): Promise<JobView> {
    this.stop();
    const started = await this.api.post<JobView>(`${this.section.apiBase()}/jobs`, input);
    this.current.set(started);
    return this.follow(started.id, this.current, (timer) => (this.timer = timer));
  }

  /** Queue a setup job for the journal and follow it. `onStarted` gets the queued job at once. */
  async runSetup(input: SetupPlanRequest & { sha256?: string }, onStarted?: (job: JobView) => void): Promise<JobView> {
    if (this.setupTimer) {
      clearTimeout(this.setupTimer);
      this.setupTimer = null;
    }
    const started = await this.api.post<JobView>('/api/setup/jobs', input);
    this.setupJob.set(started);
    onStarted?.(started);
    return this.follow(started.id, this.setupJob, (timer) => (this.setupTimer = timer));
  }

  /** Recent jobs of the current section, newest first. */
  recent(): Promise<JobView[]> {
    return this.api.get<JobView[]>(`${this.section.apiBase()}/jobs`);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private follow(
    id: string,
    sink: WritableSignal<JobView | null>,
    setTimer: (timer: ReturnType<typeof setTimeout> | null) => void,
  ): Promise<JobView> {
    return new Promise((resolve, reject) => {
      const tick = async (): Promise<void> => {
        try {
          const job = await this.api.get<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
          sink.set(job);
          if (job.status === 'done' || job.status === 'failed') {
            setTimer(null);
            resolve(job);
            return;
          }
          setTimer(setTimeout(() => void tick(), POLL_MS));
        } catch (err) {
          setTimer(null);
          reject(err as Error);
        }
      };
      void tick();
    });
  }
}
