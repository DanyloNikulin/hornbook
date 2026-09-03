import { Component, computed, inject, resource, signal } from '@angular/core';
import { SectionService } from '../section.service';
import { toObservable, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TPipe } from '../i18n.pipe';
import { I18nService } from '../i18n.service';
import { SearchService, type SearchHit } from '../search.service';

const DEBOUNCE_MS = 200;
const EXAMPLES = ['hola', 'grammar', 'greetings', 'pronoun'];

@Component({
  selector: 'app-search',
  imports: [FormsModule, RouterLink, TPipe],
  templateUrl: './search.component.html',
})
export class SearchComponent {
  protected readonly sec = inject(SectionService);
  private readonly search = inject(SearchService);
  private readonly i18n = inject(I18nService);
  private readonly route = inject(ActivatedRoute);

  protected readonly examples = EXAMPLES;
  protected readonly query = signal(this.route.snapshot.queryParamMap.get('q') ?? '');
  protected readonly debounced = toSignal(
    toObservable(this.query).pipe(debounceTime(DEBOUNCE_MS), takeUntilDestroyed()),
    { initialValue: this.query() },
  );

  // The first non-empty query kicks off the lazy index fetch (inside
  // SearchService) and then runs Fuse. Subsequent queries reuse the cached
  // Fuse instance — only the search itself runs.
  private readonly searchResource = resource<SearchHit[], string>({
    params: () => this.debounced(),
    loader: async ({ params: q }) => (q ? this.search.search(q) : []),
  });

  protected readonly loading = computed(() => this.searchResource.isLoading());
  protected readonly error = computed(() => this.searchResource.error());
  protected readonly hits = computed<SearchHit[]>(() =>
    this.searchResource.error() ? [] : (this.searchResource.value() ?? []),
  );

  protected sectionLabel(section: string): string {
    const key = `search.section.${section}`;
    const translated = this.i18n.t(key);
    return translated === key ? section : translated;
  }

  protected setQuery(q: string): void {
    this.query.set(q);
  }

  protected reload(): void {
    this.searchResource.reload();
  }
}
