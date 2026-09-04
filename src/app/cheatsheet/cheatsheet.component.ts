import { Component, computed, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TPipe } from '../i18n.pipe';
import { I18nService } from '../i18n.service';
import { CheatsheetService } from '../cheatsheet.service';
import { SectionService } from '../section.service';
import { JobsService } from '../jobs.service';
import type { CheatsheetCategoryT, CheatsheetT } from '../../lib/schema';

const EMPTY: CheatsheetT = { processed_lessons: [], categories: [] };

@Component({
  selector: 'app-cheatsheet',
  imports: [RouterLink, TPipe],
  templateUrl: './cheatsheet.component.html',
})
export class CheatsheetComponent {
  protected readonly sec = inject(SectionService);
  private readonly svc = inject(CheatsheetService);
  private readonly jobs = inject(JobsService);
  private readonly i18n = inject(I18nService);

  private readonly cheatsheetResource = resource<CheatsheetT, string>({
    params: () => this.sec.id(),
    loader: async () => this.svc.get(),
  });

  protected readonly loading = computed(() => this.cheatsheetResource.isLoading());
  protected readonly error = computed(() => this.cheatsheetResource.error());
  protected readonly cheatsheet = computed<CheatsheetT>(
    () => (this.cheatsheetResource.error() ? EMPTY : (this.cheatsheetResource.value() ?? EMPTY)),
  );
  protected readonly railQuery = signal('');
  protected readonly activeSection = signal<string | null>(null);
  protected readonly railCategories = computed(() => filterCheatsheetRail(this.cheatsheet().categories, this.railQuery()));

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

  protected sectionAnchor(categoryId: string, sectionId: string): string {
    return cheatsheetAnchor(categoryId, sectionId);
  }

  protected activateSection(categoryId: string, sectionId: string): void {
    this.activeSection.set(cheatsheetAnchor(categoryId, sectionId));
  }

  protected isActiveSection(categoryId: string, sectionId: string): boolean {
    const anchor = cheatsheetAnchor(categoryId, sectionId);
    const active = this.activeSection();
    if (active) return active === anchor;
    const first = this.cheatsheet().categories.find((category) => category.sections.length > 0)?.sections[0];
    const firstCategory = this.cheatsheet().categories.find((category) => category.sections.length > 0);
    return !!first && !!firstCategory && anchor === cheatsheetAnchor(firstCategory.id, first.id);
  }

  protected updatedAt(): string {
    const value = this.cheatsheet().updated_at;
    if (!value) return this.i18n.t('sheet.neverUpdated');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(this.i18n.locale(), { dateStyle: 'medium' }).format(date);
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
        this.jobError.set(job.error ?? this.i18n.t('sheet.failed'));
        return;
      }
      this.reload();
    } catch (err) {
      this.jobError.set((err as Error).message);
    }
  }
}

export function cheatsheetAnchor(categoryId: string, sectionId: string): string {
  return `sheet-${categoryId}-${sectionId}`;
}

export function filterCheatsheetRail(categories: readonly CheatsheetCategoryT[], query: string): CheatsheetCategoryT[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...categories];
  return categories
    .map((category) => ({
      ...category,
      sections: category.title.toLocaleLowerCase().includes(needle)
        ? category.sections
        : category.sections.filter((section) => section.title.toLocaleLowerCase().includes(needle)),
    }))
    .filter((category) => category.sections.length > 0);
}
