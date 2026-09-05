import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { JobView } from '../../lib/api-types';
import { ApiService } from '../api.service';
import { SectionService } from '../section.service';
import { TPipe } from '../i18n.pipe';

@Component({
  selector: 'app-jobs',
  imports: [DatePipe, RouterLink, TPipe],
  templateUrl: './jobs.component.html',
})
export class JobsComponent {
  private readonly api = inject(ApiService);
  private readonly destroy = inject(DestroyRef);
  protected readonly jobs = signal<JobView[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly retrying = signal<string | null>(null);
  protected readonly active = computed(() => this.jobs().filter((job) => job.status === 'queued' || job.status === 'running'));
  protected readonly finished = computed(() => this.jobs().filter((job) => job.status === 'done' || job.status === 'failed'));
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alive = true;
  private generation = 0;

  constructor() {
    inject(SectionService).set(null);
    this.destroy.onDestroy(() => {
      this.alive = false;
      clearTimeout(this.timer);
    });
    void this.load();
  }

  protected sectionLink(job: JobView): string[] | null {
    return job.section.startsWith('_') ? null : ['/', job.section];
  }

  protected percent(job: JobView): number {
    if (job.status === 'done') return 100;
    if (job.progress) return job.progress.pct;
    const stages = job.stages ?? [];
    return stages.length ? Math.round((stages.filter((stage) => stage.status === 'done' || stage.status === 'skipped').length / stages.length) * 100) : 0;
  }

  protected async retryCleanup(job: JobView): Promise<void> {
    if (this.retrying()) return;
    this.generation++;
    clearTimeout(this.timer);
    this.retrying.set(job.id);
    try {
      const updated = await this.api.post<JobView>(`/api/jobs/${encodeURIComponent(job.id)}/cleanup`, {});
      if (this.alive) this.jobs.update((jobs) => jobs.map((entry) => entry.id === job.id ? updated : entry));
    } catch (error) {
      if (this.alive) this.jobs.update((jobs) => jobs.map((entry) => entry.id === job.id ? { ...entry, cleanup: { status: 'failed', error: (error as Error).message } } : entry));
    } finally {
      this.retrying.set(null);
      this.schedule();
    }
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    try {
      const jobs = await this.api.get<JobView[]>('/api/jobs');
      if (!this.alive || generation !== this.generation) return;
      this.jobs.set(jobs);
      this.error.set(null);
    } catch (error) {
      if (this.alive && generation === this.generation) this.error.set((error as Error).message);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
    if (generation === this.generation) this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.alive && (this.active().length > 0 || this.jobs().some((job) => job.cleanup?.status === 'pending')))
      this.timer = setTimeout(() => void this.load(), 1200);
  }
}
