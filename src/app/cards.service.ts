import { Injectable, computed, inject, signal } from '@angular/core';
import { ProgressService } from './progress.service';
import { ProgressStore } from './progress-store.service';
import { SectionService } from './section.service';
import { ApiService } from './api.service';
import { DerivedCard, type DailyStateT } from '../lib/schema';
import { INITIAL, type Sm2State, type Rating, rate, today, isDue } from '../lib/sm2';

export type Direction = 'target-learner' | 'learner-target';
export type Source = 'ai' | 'vocab';

export interface Card {
  id: string;
  front: string;
  back: string;
  direction: Direction;
  source: Source;
  type: 'word' | 'phrase' | 'grammar';
  tags: readonly string[];
  lessons: readonly string[];
  // For 'word' source='vocab' cards we also know the bare target/learner pair, so the
  // typing-mode checker can compare without parsing the formatted back text.
  expected?: string;
}

export const DAILY_LIMIT = 10;
export const PAIRS_LIMIT = 5;
export const PAIRS_PER_ROUND = 5;

function emptyDaily(): DailyStateT {
  return { date: today(), target_learner: 0, learner_target: 0, pairs: 0 };
}

/**
 * Cards of the current section and the learner's SM-2 state over them.
 *
 *   • `all()` — fetches the section's pre-built card pool once per section.
 *   • `forLesson(slug)` — cards for one lesson (its AI flashcards + the
 *     relevant vocab cards), built from one lesson fetch + the shared vocab.
 *
 * SM-2 state and the daily counters live in ProgressStore (loaded by the
 * section guard, persisted to the journal folder), so nothing here touches
 * storage directly.
 */
@Injectable({ providedIn: 'root' })
export class CardsService {
  private readonly progress = inject(ProgressService);
  private readonly store = inject(ProgressStore);
  private readonly section = inject(SectionService);
  private readonly api = inject(ApiService);
  readonly revision = signal(0);

  // Per-section caches. Keys are `${section}` and `${section}/${slug}`.
  private readonly allCache = new Map<string, Promise<readonly Card[]>>();
  private readonly lessonCache = new Map<string, Promise<readonly Card[]>>();

  readonly daily = computed<DailyStateT>(() => this.store.daily() ?? emptyDaily());

  /** Drop cached pools (after a lesson was saved). */
  invalidate(id = this.section.id()): void {
    if (id === this.section.id()) this.revision.update((value) => value + 1);
    this.allCache.delete(id);
    for (const key of [...this.lessonCache.keys()]) {
      if (key.startsWith(`${id}/`)) this.lessonCache.delete(key);
    }
  }

  // ── Card construction (async) ────────────────────────────────────────────

  async all(): Promise<readonly Card[]> {
    const id = this.section.id();
    const cached = this.allCache.get(id);
    if (cached) return cached;
    const promise = this.fetchAllCards(id).catch((error: unknown) => {
      if (this.allCache.get(id) === promise) this.allCache.delete(id);
      throw error;
    });
    this.allCache.set(id, promise);
    return promise;
  }

  async forLesson(slug: string): Promise<readonly Card[]> {
    const key = `${this.section.id()}/${slug}`;
    let p = this.lessonCache.get(key);
    if (!p) {
      p = this.buildLessonCards(slug).catch((error: unknown) => {
        if (this.lessonCache.get(key) === p) this.lessonCache.delete(key);
        throw error;
      });
      this.lessonCache.set(key, p);
    }
    return p;
  }

  private async fetchAllCards(sectionId: string): Promise<readonly Card[]> {
    const raw = await this.api.get<unknown>(`/api/sections/${encodeURIComponent(sectionId)}/cards`);
    if (!Array.isArray(raw)) throw new Error('CardsService.all(): payload is not an array');
    return raw.map((entry, index) => {
      const parsed = DerivedCard.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`CardsService.all(): invalid card at index ${index}`, { cause: parsed.error });
      }
      return parsed.data;
    });
  }

  private async buildLessonCards(slug: string): Promise<readonly Card[]> {
    return (await this.all()).filter((card) => card.lessons.includes(slug));
  }

  // ── SM-2 state ───────────────────────────────────────────────────────────

  stateFor(id: string): Sm2State {
    return this.store.sm2()[id] ?? INITIAL;
  }

  isNew(id: string): boolean {
    return !(id in this.store.sm2());
  }

  newCount(pool: readonly Card[]): number {
    const state = this.store.sm2();
    return pool.filter((card) => !(card.id in state)).length;
  }

  dueIds(pool: readonly Card[], now: string = today()): readonly string[] {
    const s = this.store.sm2();
    return pool.filter((c) => isDue(s[c.id] ?? INITIAL, now)).map((c) => c.id);
  }

  // Next due card from pool, oldest-due first. Untouched cards (no state yet)
  // come last after all touched-but-due cards.
  nextDue(pool: readonly Card[], now: string = today()): Card | null {
    const s = this.store.sm2();
    const due = pool.filter((c) => isDue(s[c.id] ?? INITIAL, now));
    if (due.length === 0) return null;
    due.sort((a, b) => {
      const sa = s[a.id];
      const sb = s[b.id];
      if (sa && sb) return sa.due.localeCompare(sb.due);
      if (sa && !sb) return -1;
      if (!sa && sb) return 1;
      return 0;
    });
    return due[0];
  }

  rateCard(id: string, rating: Rating): void {
    const prev = this.store.sm2()[id] ?? INITIAL;
    this.store.setSm2({ ...this.store.sm2(), [id]: rate(prev, rating) });
    this.progress.record(1);
  }

  // Forget a single card's SM-2 state — next time it appears it is fresh.
  resetCard(id: string): void {
    const prev = this.store.sm2();
    if (!(id in prev)) return;
    const map = { ...prev };
    delete map[id];
    this.store.setSm2(map);
  }

  resetAll(): void {
    this.store.setSm2({});
  }

  // ── Daily counter ────────────────────────────────────────────────────────

  dailyDone(direction: Direction): number {
    const d = this.currentDaily();
    return direction === 'target-learner' ? d.target_learner : d.learner_target;
  }

  dailyRemaining(direction: Direction): number {
    return Math.max(0, DAILY_LIMIT - this.dailyDone(direction));
  }

  incrementDaily(direction: Direction): void {
    const base = this.currentDaily();
    this.store.setDaily(
      direction === 'target-learner'
        ? { ...base, target_learner: base.target_learner + 1 }
        : { ...base, learner_target: base.learner_target + 1 },
    );
  }

  // Pairs round counter — independent from typing direction counters.
  dailyPairsDone(): number {
    return this.currentDaily().pairs;
  }

  dailyPairsRemaining(): number {
    return Math.max(0, PAIRS_LIMIT - this.dailyPairsDone());
  }

  incrementPairs(): void {
    const base = this.currentDaily();
    this.store.setDaily({ ...base, pairs: base.pairs + 1 });
    this.progress.record(PAIRS_PER_ROUND); // round = N pair matches
  }

  // Cards usable on the pairs board: vocab cards in target→learner direction
  // (we need both sides, so AI flashcards without `expected` are excluded).
  pairsEligibleCount(pool: readonly Card[]): number {
    return pool.filter((c) => c.direction === 'target-learner' && c.source === 'vocab' && c.expected).length;
  }

  // Pick N random eligible cards for one round; [] when the pool is too small
  // (the component shows a message instead of a dead "start" button).
  pickPairsRound(pool: readonly Card[], n: number = PAIRS_PER_ROUND): readonly Card[] {
    const eligible = pool.filter(
      (c) => c.direction === 'target-learner' && c.source === 'vocab' && c.expected,
    );
    if (eligible.length < n) return [];
    const arr = [...eligible];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
  }

  // Pure read: reached from computed() chains in the flashcards component,
  // and Angular forbids signal writes inside a computed. After midnight it
  // reports a fresh counter; the next increment persists the new day.
  private currentDaily(): DailyStateT {
    const d = this.store.daily();
    return d && d.date === today() ? d : emptyDaily();
  }
}
