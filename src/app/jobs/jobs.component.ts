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
  protected readonly active = computed(() => this.jobs().filter((job) => job.status === 'queued' || job.status === 'running'));
  protected readonly finished = computed(() => this.jobs().filter((job) => job.status === 'done' || job.status === 'failed'));
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alive = true;

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

  private async load(): Promise<void> {
    try {
      this.jobs.set(await this.api.get<JobView[]>('/api/jobs'));
      this.error.set(null);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
    if (this.alive && this.active().length > 0) this.timer = setTimeout(() => void this.load(), 1200);
  }
}
