import { Component, computed, inject, resource, signal } from '@angular/core';
import { toObservable, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SearchService, type SearchHit } from '../search.service';

const DEBOUNCE_MS = 200;
const EXAMPLES = ['hola', 'grammar', 'greetings', 'pronoun'];

@Component({
  selector: 'app-search',
  imports: [FormsModule, RouterLink],
  templateUrl: './search.component.html',
})
export class SearchComponent {
  private readonly search = inject(SearchService);
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
    return (
      {
        article: 'article',
        vocab: 'glossary',
        grammar: 'grammar',
        quote: 'quote',
        slide: 'slide',
      }[section] ?? section
    );
  }

  protected setQuery(q: string): void {
    this.query.set(q);
  }

  protected reload(): void {
    this.searchResource.reload();
  }
}
