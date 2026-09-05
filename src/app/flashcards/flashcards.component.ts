import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  effect,
  ElementRef,
  inject,
  resource,
  signal,
} from '@angular/core';
import { TPipe } from '../i18n.pipe';
import { SectionService } from '../section.service';
import { LessonsService } from '../lessons.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';
import {
  CardsService,
  DAILY_LIMIT,
  PAIRS_LIMIT,
  PAIRS_PER_ROUND,
  type Card,
  type Direction,
} from '../cards.service';
import { checkTypedAnswer, type TypedResult } from '../../lib/answer-grading';
import type { Rating } from '../../lib/sm2';

type Mode = 'type' | 'pairs';
type LevelFilter = 'all' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
const LEVELS: readonly LevelFilter[] = ['all', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const DIR_KEY = 'flashcards-direction';
const MODE_KEY = 'flashcards-mode';
const LEVEL_KEY = 'flashcards-level';
const MISMATCH_FLASH_MS = 600;

@Component({
  selector: 'app-flashcards',
  imports: [RouterLink, FormsModule, TPipe],
  templateUrl: './flashcards.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlashcardsComponent {
  protected readonly sec = inject(SectionService);
  private readonly journal = this.sec;
  protected get pairFwd() { return this.journal.labels().fwd; }
  protected get pairRev() { return this.journal.labels().rev; }
  protected get targetName() { return this.journal.targetName(); }
  protected get learnerName() { return this.journal.learnerName(); }
  protected get speechLang() { return this.journal.speechLang(); }
  private readonly cards = inject(CardsService);
  protected readonly lessons = inject(LessonsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly DAILY_LIMIT = DAILY_LIMIT;
  protected readonly PAIRS_LIMIT = PAIRS_LIMIT;
  protected readonly PAIRS_PER_ROUND = PAIRS_PER_ROUND;

  protected readonly lessonFilter = toSignal(
    this.route.queryParamMap.pipe(map((q) => q.get('lesson'))),
    { initialValue: null },
  );

  protected readonly direction = signal<Direction>(this.loadDirection());
  protected readonly mode = signal<Mode>(this.loadMode());
  protected readonly level = signal<LevelFilter>(this.loadLevel());
  protected readonly levels = LEVELS;

  // A lesson deck is a stable one-pass queue. It deliberately includes cards
  // that are not due yet and does not consume the daily all-cards allowance.
  protected readonly lessonQueue = signal<readonly Card[]>([]);
  protected readonly lessonDone = signal(0);

  // ---- card loading (lazy, per-lesson-or-all) ----

  // Whatever lesson filter is active drives the fetch. `null` (no filter)
  // means load the single pre-built global cards asset via `cards.all()`.
  // Switching filters re-triggers the loader; in-flight requests are cancelled.
  private readonly cardsResource = resource<readonly Card[], { slug: string | null; section: string; revision: number }>({
    params: () => ({ slug: this.lessonFilter(), section: this.sec.id(), revision: this.cards.revision() }),
    loader: async ({ params }) => (params.slug ? this.cards.forLesson(params.slug) : this.cards.all()),
  });

  protected readonly cardsLoading = computed(() => this.cardsResource.isLoading());
  protected readonly cardsError = computed(() => this.cardsResource.error());
  protected readonly cardsValue = computed<readonly Card[]>(() =>
    this.cardsResource.error() ? [] : (this.cardsResource.value() ?? []),
  );

  // ---- typing-mode state ----

  protected readonly pool = computed<readonly Card[]>(() => {
    const dir = this.direction();
    const lvl = this.level();
    return this.cardsValue().filter((c) => {
      if (c.direction !== dir) return false;
      if (lvl !== 'all' && !c.tags.includes(lvl)) return false;
      return true;
    });
  });

  protected readonly dailyDone = computed(() => this.cards.dailyDone(this.direction()));
  protected readonly dailyRemaining = computed(() => this.cards.dailyRemaining(this.direction()));
  protected readonly poolSize = computed(() => this.pool().length);
  protected readonly lessonOptions = computed(() => this.lessons.allMeta());
  protected readonly lessonTotal = computed(() => this.lessonQueue().length);
  protected readonly deckDue = computed(() => this.cards.dueIds(this.pool()).length);
  protected readonly deckNew = computed(() => this.cards.newCount(this.pool()));

  protected readonly current = computed<Card | null>(() => {
    if (this.mode() !== 'type') return null;
    if (this.lessonFilter()) {
      return this.lessonQueue()[this.lessonDone()] ?? null;
    }
    if (this.cards.dailyRemaining(this.direction()) <= 0) return null;
    return this.cards.nextDue(this.pool());
  });

  protected readonly cardNumber = computed(() =>
    this.lessonFilter() ? this.lessonDone() + 1 : this.dailyDone() + 1,
  );
  protected readonly cardTotal = computed(() =>
    this.lessonFilter() ? this.lessonTotal() : DAILY_LIMIT,
  );
  protected readonly currentIsNew = computed(() => {
    const card = this.current();
    return card ? this.cards.isNew(card.id) : false;
  });

  protected readonly typed = signal('');
  protected readonly typedResult = signal<TypedResult | null>(null);
  protected readonly revealed = signal(false);

  @ViewChild('typeInput') private typeInput?: ElementRef<HTMLInputElement>;
  @ViewChild('nextButton') private nextButton?: ElementRef<HTMLButtonElement>;

  // ---- pairs-mode state ----

  protected readonly pairsLeft = signal<readonly Card[]>([]);
  protected readonly pairsRight = signal<readonly Card[]>([]);
  protected readonly pairsSelectedLeft = signal<string | null>(null);
  protected readonly pairsMatched = signal<ReadonlySet<string>>(new Set());
  protected readonly pairsWrongLeft = signal<string | null>(null);
  protected readonly pairsWrongRight = signal<string | null>(null);

  protected readonly pairsDone = computed(() => this.cards.dailyPairsDone());
  protected readonly pairsRemaining = computed(() => this.cards.dailyPairsRemaining());
  protected readonly pairsRoundActive = computed(() => this.pairsLeft().length > 0);
  // A round needs PAIRS_PER_ROUND vocab cards; a narrow ?lesson= filter can
  // have fewer, in which case "Start" would silently do nothing.
  protected readonly pairsEligible = computed(() => this.cards.pairsEligibleCount(this.cardsValue()));
  protected readonly pairsPossible = computed(() => this.pairsEligible() >= PAIRS_PER_ROUND);
  protected readonly pairsRoundComplete = computed(
    () => this.pairsLeft().length > 0 && this.pairsMatched().size === this.pairsLeft().length,
  );

  constructor() {
    // Reset typing UI on card change.
    effect(() => {
      this.current(); // subscribe
      this.typed.set('');
      this.typedResult.set(null);
      this.revealed.set(false);
    });

    // Persist prefs.
    effect(() => this.saveDirection(this.direction()));
    effect(() => this.saveMode(this.mode()));
    effect(() => this.saveLevel(this.level()));

    // Rebuild the one-pass lesson queue when its lesson, direction, or level changes.
    effect(() => {
      const slug = this.lessonFilter();
      const pool = this.pool();
      if (slug) this.mode.set('type');
      this.lessonQueue.set(slug ? [...pool] : []);
      this.lessonDone.set(0);
    });

    // Focus the type input when active.
    effect(() => {
      if (this.mode() === 'type' && this.current()) {
        const revealed = this.revealed();
        queueMicrotask(() => (revealed ? this.nextButton : this.typeInput)?.nativeElement.focus());
      }
    });

    // Clear pairs board when leaving pairs mode.
    effect(() => {
      if (this.mode() !== 'pairs') this.resetPairsBoard();
    });

    // When a pairs round completes, count it once.
    effect(() => {
      if (this.pairsRoundComplete()) {
        // queueMicrotask so the writable signal updates land outside the
        // current change-detection pass (avoids reentrancy warnings).
        queueMicrotask(() => this.cards.incrementPairs());
      }
    });
  }

  // ---- typing handlers ----

  protected submitTyped(): void {
    const card = this.current();
    if (!card) return;
    const expected = card.expected ?? card.back;
    this.typedResult.set(checkTypedAnswer(this.typed(), expected, this.journal.targetCode()));
    this.revealed.set(true);
  }

  protected nextCard(): void {
    const card = this.current();
    const r = this.typedResult();
    if (!card || !r) return;
    const rating: Rating = r === 'exact' ? 5 : r === 'close' ? 3 : 1;
    this.cards.rateCard(card.id, rating);
    if (this.lessonFilter()) {
      this.lessonDone.update((n) => n + 1);
    } else {
      this.cards.incrementDaily(this.direction());
    }
  }

  protected skipCurrent(): void {
    if (!this.lessonFilter() || !this.current()) return;
    this.lessonDone.update((n) => n + 1);
  }

  protected resetCurrent(): void {
    const card = this.current();
    if (!card) return;
    this.cards.resetCard(card.id);
    this.revealed.set(false);
    this.typed.set('');
    this.typedResult.set(null);
  }

  protected speakFront(): void {
    const card = this.current();
    if (!card || card.direction !== 'target-learner') return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(card.front);
    u.lang = this.speechLang;
    u.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // ---- pairs handlers ----

  protected startPairsRound(): void {
    const picked = this.cards.pickPairsRound(this.cardsValue(), PAIRS_PER_ROUND);
    if (picked.length === 0) {
      this.resetPairsBoard();
      return;
    }
    this.pairsLeft.set(picked);
    this.pairsRight.set(shuffle(picked));
    this.pairsMatched.set(new Set());
    this.pairsSelectedLeft.set(null);
    this.pairsWrongLeft.set(null);
    this.pairsWrongRight.set(null);
  }

  protected selectPairLeft(card: Card): void {
    if (this.pairsMatched().has(card.id)) return;
    this.pairsSelectedLeft.set(card.id);
  }

  protected selectPairRight(card: Card): void {
    if (this.pairsMatched().has(card.id)) return;
    const left = this.pairsSelectedLeft();
    if (!left) return;
    if (left === card.id) {
      const m = new Set(this.pairsMatched());
      m.add(card.id);
      this.pairsMatched.set(m);
      this.pairsSelectedLeft.set(null);
    } else {
      this.pairsWrongLeft.set(left);
      this.pairsWrongRight.set(card.id);
      setTimeout(() => {
        this.pairsWrongLeft.set(null);
        this.pairsWrongRight.set(null);
        this.pairsSelectedLeft.set(null);
      }, MISMATCH_FLASH_MS);
    }
  }

  protected resetPairsBoard(): void {
    this.pairsLeft.set([]);
    this.pairsRight.set([]);
    this.pairsSelectedLeft.set(null);
    this.pairsMatched.set(new Set());
    this.pairsWrongLeft.set(null);
    this.pairsWrongRight.set(null);
  }

  protected reloadCards(): void {
    this.cardsResource.reload();
  }

  protected selectDeck(slug: string): void {
    void this.router.navigate(this.sec.link('flashcards'), {
      queryParams: slug ? { lesson: slug } : {},
    });
  }

  protected exampleFor(card: Card): string | null {
    if (card.source !== 'vocab') return null;
    const parts = card.back.split(/\n\s*\n/);
    return parts.length > 1 ? parts.slice(1).join('\n\n').trim() || null : null;
  }

  protected submitFromKeyboard(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    this.submitTyped();
  }

  // ---- prefs ----

  private loadDirection(): Direction {
    if (typeof localStorage === 'undefined') return 'target-learner';
    try {
      const raw = localStorage.getItem(DIR_KEY);
      return raw === 'learner-target' ? 'learner-target' : 'target-learner';
    } catch {
      return 'target-learner';
    }
  }

  private saveDirection(d: Direction): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(DIR_KEY, d);
    } catch {
      // ignore
    }
  }

  private loadMode(): Mode {
    if (typeof localStorage === 'undefined') return 'type';
    try {
      const raw = localStorage.getItem(MODE_KEY);
      return raw === 'pairs' ? 'pairs' : 'type';
    } catch {
      return 'type';
    }
  }

  private saveMode(m: Mode): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // ignore
    }
  }

  private loadLevel(): LevelFilter {
    if (typeof localStorage === 'undefined') return 'all';
    try {
      const raw = localStorage.getItem(LEVEL_KEY) as LevelFilter | null;
      return raw && LEVELS.includes(raw) ? raw : 'all';
    } catch {
      return 'all';
    }
  }

  private saveLevel(l: LevelFilter): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(LEVEL_KEY, l);
    } catch {
      // ignore
    }
  }
}

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
