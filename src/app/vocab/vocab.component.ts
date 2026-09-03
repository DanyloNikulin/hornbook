import { Component, computed, inject, resource, signal } from '@angular/core';
import { SectionService } from '../section.service';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TPipe } from '../i18n.pipe';
import { VocabService } from '../vocab.service';
import type { DerivedVocabT, LevelT } from '../../lib/schema';

const LEVELS: readonly LevelT[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PAGE_SIZE = 15;

@Component({
  selector: 'app-vocab',
  imports: [FormsModule, RouterLink, TPipe],
  templateUrl: './vocab.component.html',
})
export class VocabComponent {
  protected readonly sec = inject(SectionService);
  private readonly vocabSvc = inject(VocabService);
  private readonly journal = this.sec;
  protected readonly targetName = this.journal.targetName();
  protected readonly learnerName = this.journal.learnerName();
  protected readonly speechLang = this.journal.speechLang();

  protected readonly PAGE_SIZE = PAGE_SIZE;
  protected readonly levels = LEVELS;
  protected readonly query = signal('');
  protected readonly levelFilter = signal<LevelT | 'all'>('all');
  protected readonly page = signal(0);
  protected readonly speakingWord = signal<string | null>(null);

  // Lazy-fetched vocab list. The resource params don't change (no slug to
  // key on), so the loader runs once and the value sticks.
  private readonly vocabResource = resource<readonly DerivedVocabT[], boolean>({
    params: () => true,
    loader: async () => this.vocabSvc.all(),
  });

  protected readonly loading = computed(() => this.vocabResource.isLoading());
  protected readonly error = computed(() => this.vocabResource.error());
  protected readonly vocab = computed<readonly DerivedVocabT[]>(
    () => (this.vocabResource.error() ? [] : (this.vocabResource.value() ?? [])),
  );

  protected readonly filtered = computed<readonly DerivedVocabT[]>(() => {
    const q = this.query().trim().toLowerCase();
    const lvl = this.levelFilter();
    return this.vocab().filter((v) => {
      if (lvl !== 'all' && v.level !== lvl) return false;
      if (!q) return true;
      // Match only the headword + translation, not the example sentence —
      // example matches produced noisy results (common words appear in many
      // examples), making it feel like search went "by example, not by word".
      return v.target.toLowerCase().includes(q) || v.learner.toLowerCase().includes(q);
    });
  });

  protected readonly totalPages = computed(() =>
    Math.ceil(this.filtered().length / PAGE_SIZE),
  );

  protected readonly paginated = computed<readonly DerivedVocabT[]>(() => {
    const p = this.page();
    return this.filtered().slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  });

  protected readonly pageStart = computed(() => this.page() * PAGE_SIZE + 1);
  protected readonly pageEnd = computed(() =>
    Math.min((this.page() + 1) * PAGE_SIZE, this.filtered().length),
  );

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

  protected setQuery(q: string): void {
    this.query.set(q);
    this.page.set(0);
  }

  protected setLevelFilter(lvl: LevelT | 'all'): void {
    this.levelFilter.set(lvl);
    this.page.set(0);
  }

  protected reload(): void {
    this.vocabResource.reload();
  }

  protected speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.speechLang;
    u.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    this.speakingWord.set(text);
    setTimeout(() => this.speakingWord.set(null), 700);
  }
}
