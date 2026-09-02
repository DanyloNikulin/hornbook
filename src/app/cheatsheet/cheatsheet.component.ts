import { Component, computed, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CheatsheetService } from '../cheatsheet.service';
import type { CheatsheetCategoryT, CheatsheetT } from '../../lib/schema';

const EMPTY: CheatsheetT = { processed_lessons: [], categories: [] };

@Component({
  selector: 'app-cheatsheet',
  imports: [RouterLink],
  templateUrl: './cheatsheet.component.html',
})
export class CheatsheetComponent {
  private readonly svc = inject(CheatsheetService);

  // Lazy fetch — the cheat sheet ships as /cheatsheet.json via the assets
  // glob; this component triggers the download on first /cheatsheet visit.
  private readonly cheatsheetResource = resource<CheatsheetT, boolean>({
    params: () => true,
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

  protected setCategory(id: string | null): void {
    this.activeCategory.set(id);
  }

  protected reload(): void {
    this.cheatsheetResource.reload();
  }
}
