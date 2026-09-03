import { Component, computed, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CheatsheetService } from '../cheatsheet.service';
import { SectionService } from '../section.service';
import { JobsService } from '../jobs.service';
import type { CheatsheetCategoryT, CheatsheetT } from '../../lib/schema';

const EMPTY: CheatsheetT = { processed_lessons: [], categories: [] };

@Component({
  selector: 'app-cheatsheet',
  imports: [RouterLink],
  templateUrl: './cheatsheet.component.html',
})
export class CheatsheetComponent {
  protected readonly sec = inject(SectionService);
  private readonly svc = inject(CheatsheetService);
  private readonly jobs = inject(JobsService);

  private readonly cheatsheetResource = resource<CheatsheetT, string>({
    params: () => this.sec.id(),
    loader: async () => this.svc.get(),
  });

  protected readonly loading = computed(() => this.cheatsheetResource.isLoading());
  protected readonly error = computed(() => this.cheatsheetResource.error());
  protected readonly cheatsheet = computed<CheatsheetT>(
    () => (this.cheatsheetResource.error() ? EMPTY : (this.cheatsheetResource.value() ?? EMPTY)),
  );
  protected readonly activeCategory = signal<string | null>(null);

  protected readonly visibleCategories = computed<CheatsheetCategoryT[]>(() => {
    const active = this.activeCategory();
    if (active === null) return this.cheatsheet().categories;
    return this.cheatsheet().categories.filter((c) => c.id === active);
  });

  protected readonly totalSections = computed(() =>
    this.cheatsheet().categories.reduce((n, c) => n + c.sections.length, 0),
  );

  // Rebuild job (runs scripts/build-cheatsheet.ts on the server).
  protected readonly job = computed(() => this.jobs.current());
  protected readonly jobRunning = computed(() => {
    const j = this.job();
    return j?.status === 'queued' || j?.status === 'running';
  });
  protected readonly jobError = signal<string | null>(null);
  protected readonly showLog = signal(false);

  protected setCategory(id: string | null): void {
    this.activeCategory.set(id);
  }

  protected reload(): void {
    this.svc.invalidate();
    this.cheatsheetResource.reload();
  }

  /** Merge lessons not yet in the sheet (or rebuild everything with force). */
  protected async rebuild(force = false): Promise<void> {
    this.jobError.set(null);
    this.showLog.set(true);
    try {
      const job = await this.jobs.run({ kind: 'cheatsheet', force });
      if (job.status !== 'done') {
        this.jobError.set(job.error ?? 'Cheat sheet build failed — see the log.');
        return;
      }
      this.reload();
    } catch (err) {
      this.jobError.set((err as Error).message);
    }
  }
}
