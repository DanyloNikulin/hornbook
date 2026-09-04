import { Component, computed, effect, inject, resource, signal } from '@angular/core';
import { SectionService } from '../section.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { LessonsService } from '../lessons.service';
import { QuizResultsService, type QuizResult } from '../quiz-results.service';
import { VocabService } from '../vocab.service';
import { ProgressService } from '../progress.service';
import { today } from '../../lib/sm2';
import { type DerivedVocabT, type LessonMetaT, type TopicT } from '../../lib/schema';
import { isStockTagline } from '../../lib/i18n';
import { TPipe } from '../i18n.pipe';
import { JournalService } from '../journal.service';

const PAGE_SIZE = 12;

@Component({
  selector: 'app-lesson-list',
  imports: [RouterLink, TPipe],
  templateUrl: './lesson-list.component.html',
})
export class LessonListComponent {
  protected readonly sec = inject(SectionService);
  private readonly journal = inject(JournalService);
  protected readonly brandName = this.journal.brandName();
  protected readonly tagline = computed(() => this.journal.tagline());
  protected readonly stockTagline = computed(() => isStockTagline(this.tagline()));
  private readonly lessonsSvc = inject(LessonsService);
  private readonly results = inject(QuizResultsService);
  private readonly vocab = inject(VocabService);
  private readonly progress = inject(ProgressService);
  private readonly route = inject(ActivatedRoute);
  protected readonly router = inject(Router);

  protected readonly PAGE_SIZE = PAGE_SIZE;

  // Manifest was loaded by the section guard; a signal so a save refreshes it.
  private readonly allMetas = computed(() => this.lessonsSvc.metas());
  protected readonly loadError = computed(() => this.lessonsSvc.loadError());

  // Word of day pulls from the lazy-loaded vocab. The page renders without
  // it on cold visits; the cell pops in once the fetch resolves.
  private readonly wordOfDayResource = resource<DerivedVocabT | null, string>({
    params: () => today(),
    loader: async ({ params: date }) => this.vocab.wordOfDay(date),
  });
  protected readonly wordOfDay = computed(() =>
    this.wordOfDayResource.error() ? null : (this.wordOfDayResource.value() ?? null),
  );

  // ?topic=… narrows the catalog. A topic no lesson carries silently degrades
  // to "no filter" so a stale bookmark doesn't strand the user on an empty list.
  private readonly topicParam = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('topic'))),
    { initialValue: null },
  );
  protected readonly activeTopic = computed<TopicT | null>(() => {
    const t = this.topicParam();
    return t && this.allMetas().some((m) => m.topics.includes(t)) ? t : null;
  });

  protected readonly lessons = computed<readonly LessonMetaT[]>(() => {
    const topic = this.activeTopic();
    if (!topic) return this.allMetas();
    return this.allMetas().filter((l) => l.topics.includes(topic));
  });

  // ---- pagination ----
  protected readonly page = signal(0);

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.lessons().length / PAGE_SIZE)),
  );

  protected readonly paginated = computed<readonly LessonMetaT[]>(() => {
    const p = this.page();
    return this.lessons().slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  });

  protected readonly pageStart = computed(() => this.page() * PAGE_SIZE + 1);
  protected readonly pageEnd = computed(() =>
    Math.min((this.page() + 1) * PAGE_SIZE, this.lessons().length),
  );

  // Page-number row with ellipsis for >9 pages. Same pattern as VocabComponent.
  protected readonly pageNumbers = computed<readonly (number | null)[]>(() => {
    const total = this.totalPages();
    const cur = this.page();
    if (total <= 9) return Array.from({ length: total }, (_, i) => i);
    const nums: (number | null)[] = [0];
    if (cur > 2) nums.push(null);
    for (let i = Math.max(1, cur - 1); i <= Math.min(total - 2, cur + 1); i++) nums.push(i);
    if (cur < total - 3) nums.push(null);
    nums.push(total - 1);
    return nums;
  });

  constructor() {
    // Reset to page 0 whenever the filter changes — otherwise we'd render an
    // empty page if the user was on page 3 of all lessons and applies a
    // narrow topic filter that only has 5 results.
    effect(() => {
      this.activeTopic(); // subscribe
      this.page.set(0);
    });
  }

  protected readonly streak = computed(() => {
    this.progress.activity();
    return this.progress.streakDays();
  });

  protected readonly heatmap = computed(() => {
    this.progress.activity();
    return this.progress.heatmap(8);
  });

  protected readonly totalActive = computed(() => {
    const a = this.progress.activity();
    return Object.values(a).reduce((sum, n) => sum + n, 0);
  });

  protected quizResult(slug: string): QuizResult | null {
    return this.results.forLesson(slug);
  }

  protected isPassed(r: QuizResult): boolean {
    return r.best_score >= r.total * 0.8;
  }

  protected goSearch(value: string): void {
    const q = value.trim();
    this.router.navigate(this.sec.link('search'), q ? { queryParams: { q } } : {});
  }

  protected goRandom(): void {
    const next = this.lessonsSvc.pickRandomMeta();
    if (next) this.router.navigate(this.sec.link('lesson', next.slug));
  }

  protected clearTopic(): void {
    // Drop just the topic param; preserves any other params we might add later.
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { topic: null },
      queryParamsHandling: 'merge',
    });
  }

  protected lessonNum(i: number): string {
    return String(i + 1).padStart(2, '0');
  }

  protected absIndex(pageIndex: number): number {
    return this.page() * PAGE_SIZE + pageIndex;
  }

  protected quizProgress(slug: string): number {
    const r = this.results.forLesson(slug);
    if (!r) return 0;
    return Math.round((r.best_score / r.total) * 100);
  }

  protected cellClass(count: number): string {
    if (count === 0) return 'il-heatmap-cell il-heatmap-cell-0';
    if (count <= 3) return 'il-heatmap-cell il-heatmap-cell-1';
    if (count <= 8) return 'il-heatmap-cell il-heatmap-cell-2';
    if (count <= 15) return 'il-heatmap-cell il-heatmap-cell-3';
    return 'il-heatmap-cell il-heatmap-cell-4';
  }
}
