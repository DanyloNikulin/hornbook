import { Injectable, inject, signal } from '@angular/core';
import type { JobView, StartJob } from '../lib/api-types';
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
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Queue a job and follow it. Resolves with the finished job. */
  async run(input: StartJob): Promise<JobView> {
    this.stop();
    const started = await this.api.post<JobView>(`${this.section.apiBase()}/jobs`, input);
    this.current.set(started);
    return this.follow(started.id);
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

  private follow(id: string): Promise<JobView> {
    return new Promise((resolve, reject) => {
      const tick = async (): Promise<void> => {
        try {
          const job = await this.api.get<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
          this.current.set(job);
          if (job.status === 'done' || job.status === 'failed') {
            this.timer = null;
            resolve(job);
            return;
          }
          this.timer = setTimeout(() => void tick(), POLL_MS);
        } catch (err) {
          this.timer = null;
          reject(err as Error);
        }
      };
      void tick();
    });
  }
}
