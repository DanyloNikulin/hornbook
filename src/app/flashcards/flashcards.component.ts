import {
  Component,
  HostListener,
  ViewChild,
  computed,
  effect,
  ElementRef,
  inject,
  resource,
  signal,
} from '@angular/core';
import { SectionService } from '../section.service';
import { ActivatedRoute, RouterLink } from '@angular/router';
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
  type TypedResult,
  checkTypedAnswer,
} from '../cards.service';
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
  imports: [RouterLink, FormsModule],
  templateUrl: './flashcards.component.html',
})
export class FlashcardsComponent {
  protected readonly sec = inject(SectionService);
  private readonly journal = this.sec;
  protected readonly pairFwd = this.journal.labels().fwd;
  protected readonly pairRev = this.journal.labels().rev;
  protected readonly targetName = this.journal.targetName();
  protected readonly learnerName = this.journal.learnerName();
  protected readonly speechLang = this.journal.speechLang();
  private readonly cards = inject(CardsService);
  private readonly route = inject(ActivatedRoute);

  protected readonly DAILY_LIMIT = DAILY_LIMIT;
  protected readonly PAIRS_LIMIT = PAIRS_LIMIT;
  protected readonly PAIRS_PER_ROUND = PAIRS_PER_ROUND;

  protected readonly lessonFilter = toSignal(
    this.route.queryParamMap.pipe(map((q) => q.get('lesson'))),
    { initialValue: null },
  );

  // Mini-session: limit pool to N cards from a lesson, bypass daily cap.
  // Triggered by `?lesson=<slug>&mini=5` from the lesson page.
  protected readonly miniLimit = toSignal(
    this.route.queryParamMap.pipe(
      map((q) => {
        const raw = q.get('mini');
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n > 0 && n <= 50 ? n : null;
      }),
    ),
    { initialValue: null },
  );

  protected readonly direction = signal<Direction>(this.loadDirection());
  protected readonly mode = signal<Mode>(this.loadMode());
  protected readonly level = signal<LevelFilter>(this.loadLevel());
  protected readonly levels = LEVELS;

  // Counts user-rated cards within the current mini-session.
  protected readonly miniDone = signal(0);

  // ---- card loading (lazy, per-lesson-or-all) ----

  // Whatever lesson filter is active drives the fetch. `null` (no filter)
  // means load the single pre-built global cards asset via `cards.all()`.
  // Switching filters re-triggers the loader; in-flight requests are cancelled.
  private readonly cardsResource = resource<readonly Card[], string | null>({
    params: () => this.lessonFilter(),
    loader: async ({ params: slug }) => (slug ? this.cards.forLesson(slug) : this.cards.all()),
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
  protected readonly isMini = computed(() => this.miniLimit() !== null);

  protected readonly current = computed<Card | null>(() => {
    if (this.mode() !== 'type') return null;
    const mini = this.miniLimit();
    if (mini !== null) {
      if (this.miniDone() >= mini) return null;
      return this.cards.nextDue(this.pool());
    }
    if (this.cards.dailyRemaining(this.direction()) <= 0) return null;
    return this.cards.nextDue(this.pool());
  });

  protected readonly typed = signal('');
  protected readonly typedResult = signal<TypedResult | null>(null);
  protected readonly revealed = signal(false);

  @ViewChild('typeInput') private typeInput?: ElementRef<HTMLInputElement>;

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

    // Reset mini-session counter when entering/leaving mini mode or switching lesson.
    effect(() => {
      this.miniLimit();
      this.lessonFilter();
      this.miniDone.set(0);
    });

    // Focus the type input when active.
    effect(() => {
      if (this.mode() === 'type' && this.current() && !this.revealed()) {
        queueMicrotask(() => this.typeInput?.nativeElement.focus());
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
    if (this.isMini()) {
      this.miniDone.update((n) => n + 1);
    } else {
      this.cards.incrementDaily(this.direction());
    }
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

  // ---- keyboard ----

  // Enter submits/advances in type mode only.
  @HostListener('document:keydown.enter', ['$event'])
  protected onEnter(e: Event): void {
    if (this.mode() !== 'type' || !this.current()) return;
    e.preventDefault();
    if (this.revealed()) this.nextCard();
    else this.submitTyped();
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
