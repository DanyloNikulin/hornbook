import { Injectable, inject, signal } from '@angular/core';
import { z } from 'zod';
import { LessonsService } from './lessons.service';
import { VocabService } from './vocab.service';
import { ProgressService } from './progress.service';
import { DerivedCard } from '../lib/schema';
import { deriveExpectedFromBack } from '../lib/card-text';
import { INITIAL, type Sm2State, type Rating, cardId, rate, today, isDue } from '../lib/sm2';
import { idbGet, idbSet, migrateFromLocalStorage } from '../lib/storage';

export { deriveExpectedFromBack } from '../lib/card-text';

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
  // For 'word' source='vocab' cards we also know the bare it/uk pair, so the
  // typing-mode checker can compare without parsing the formatted back text.
  expected?: string;
}

const STATE_KEY = 'lj-sm2-state';
const DAILY_KEY = 'lj-flashcards-daily';
export const DAILY_LIMIT = 10;
export const PAIRS_LIMIT = 5;
export const PAIRS_PER_ROUND = 5;

type StateMap = Record<string, Sm2State>;

const Sm2StateSchema: z.ZodType<Sm2State> = z.object({
  interval: z.number().int().nonnegative(),
  ef: z.number().min(1.3).max(10),
  repetitions: z.number().int().nonnegative(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const StateMapSchema = z.record(z.string(), Sm2StateSchema);

interface DailyState {
  date: string;
  target_learner: number;
  learner_target: number;
  pairs: number;
}

const DailyStateSchema: z.ZodType<DailyState> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  target_learner: z.number().int().nonnegative(),
  learner_target: z.number().int().nonnegative(),
  pairs: z.number().int().nonnegative(),
});

function emptyDaily(): DailyState {
  return { date: today(), target_learner: 0, learner_target: 0, pairs: 0 };
}

/**
 * Cards are loaded lazily through two paths:
 *
 *   • `all()` — fetches the pre-built `/lessons/_cards.json` asset once. This
 *     keeps the unfiltered flashcards screen to one request regardless of the
 *     lesson count.
 *   • `forLesson(slug)` — promise of cards for one lesson. Cheap: one lesson
 *     fetch + the (shared) vocab fetch.
 *
 * Both paths share an in-flight promise cache so concurrent callers don't
 * trigger duplicate work. Cards are immutable after construction — we never
 * invalidate the cache during a session (the underlying static assets don't
 * change without a rebuild).
 */
@Injectable({ providedIn: 'root' })
export class CardsService {
  private readonly lessonsSvc = inject(LessonsService);
  private readonly vocabSvc = inject(VocabService);
  private readonly progress = inject(ProgressService);

  // Per-lesson card promise cache. Each entry resolves to the merged cards
  // for one lesson (its AI flashcards + the relevant vocab cards).
  private readonly lessonCardsCache = new Map<string, Promise<readonly Card[]>>();

  // Promise of the full union of cards across all lessons. Set lazily by
  // `all()` and reused for subsequent calls in the same session.
  private allCardsPromise: Promise<readonly Card[]> | null = null;

  // Signals start with empty defaults; the async init below populates them
  // (and runs the one-time localStorage→IDB migration). Computed signals
  // in flashcards.component re-evaluate once the load lands, so untouched
  // cards appear briefly as "all due, no state" — visually identical to a
  // fresh user, and the actual stored state takes over a microtask later.
  private readonly state = signal<StateMap>({});
  private readonly _daily = signal<DailyState>(emptyDaily());
  readonly daily = this._daily.asReadonly();

  // Resolves once both keys have been migrated/loaded. Awaited by tests;
  // production callers rely on the reactive signal updates instead.
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await Promise.all([this.initState(), this.initDaily()]);
  }

  private async initState(): Promise<void> {
    const migrated = await migrateFromLocalStorage<unknown>(STATE_KEY);
    const raw = migrated !== undefined ? migrated : await idbGet<unknown>(STATE_KEY);
    if (raw === undefined) return;
    const parsed = StateMapSchema.safeParse(raw);
    if (parsed.success) this.state.set(parsed.data);
  }

  private async initDaily(): Promise<void> {
    const migrated = await migrateFromLocalStorage<unknown>(DAILY_KEY);
    const raw = migrated !== undefined ? migrated : await idbGet<unknown>(DAILY_KEY);
    if (raw === undefined) return;
    const parsed = DailyStateSchema.safeParse(raw);
    if (!parsed.success) return;
    // Discard the persisted counter if the date has rolled over since the
    // user last opened the app — same behaviour the old sync loader had.
    if (parsed.data.date !== today()) return;
    this._daily.set(parsed.data);
  }

  // ── Card construction (async) ────────────────────────────────────────────

  async all(): Promise<readonly Card[]> {
    if (this.allCardsPromise) return this.allCardsPromise;
    const promise = this.fetchAllCards().catch((error: unknown) => {
      this.allCardsPromise = null;
      throw error;
    });
    this.allCardsPromise = promise;
    return promise;
  }

  async forLesson(slug: string): Promise<readonly Card[]> {
    let p = this.lessonCardsCache.get(slug);
    if (!p) {
      p = this.buildLessonCards(slug).catch((error: unknown) => {
        this.lessonCardsCache.delete(slug);
        throw error;
      });
      this.lessonCardsCache.set(slug, p);
    }
    return p;
  }

  private async fetchAllCards(): Promise<readonly Card[]> {
    const response = await fetch('lessons/_cards.json', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`CardsService.all(): HTTP ${response.status}`);
    const raw = (await response.json()) as unknown;
    if (!Array.isArray(raw)) throw new Error('CardsService.all(): payload is not an array');
    return raw.map((entry, index) => {
      const parsed = DerivedCard.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`CardsService.all(): invalid card at index ${index}`, {
          cause: parsed.error,
        });
      }
      return parsed.data;
    });
  }

  private async buildLessonCards(slug: string): Promise<readonly Card[]> {
    const [lesson, vocab] = await Promise.all([this.lessonsSvc.bySlug(slug), this.vocabSvc.all()]);
    if (!lesson) return [];

    const byId = new Map<string, Card>();

    // 1. Vocab cards — only entries seen in this lesson. Each entry produces
    //    two cards (forward + reverse). cardId is hashed from front+back so
    //    reverse direction naturally gets its own SM-2 state.
    for (const v of vocab) {
      if (!v.seen_in.includes(slug)) continue;
      const tags = v.level ? [v.level] : [];

      const fwdBack = v.example_target ? `${v.learner}\n\n${v.example_target}` : v.learner;
      const fwdId = cardId(v.target, fwdBack);
      byId.set(fwdId, {
        id: fwdId,
        front: v.target,
        back: fwdBack,
        direction: 'target-learner',
        source: 'vocab',
        type: 'word',
        tags,
        lessons: v.seen_in,
        expected: v.learner,
      });

      const revBack = v.example_target ? `${v.target}\n\n${v.example_target}` : v.target;
      const revId = cardId(v.learner, revBack);
      byId.set(revId, {
        id: revId,
        front: v.learner,
        back: revBack,
        direction: 'learner-target',
        source: 'vocab',
        type: 'word',
        tags,
        lessons: v.seen_in,
        expected: v.target,
      });
    }

    // 2. AI-curated flashcards from this lesson. One-directional (it→uk).
    for (const fc of lesson.flashcards) {
      const id = cardId(fc.front, fc.back);
      const existing = byId.get(id);
      if (existing) {
        byId.set(id, {
          ...existing,
          source: 'ai',
          tags: dedupe([...existing.tags, ...fc.tags]),
          lessons: dedupe([...existing.lessons, lesson.slug]),
        });
      } else {
        byId.set(id, {
          id,
          front: fc.front,
          back: fc.back,
          direction: 'target-learner',
          source: 'ai',
          type: fc.type,
          tags: fc.tags,
          lessons: [lesson.slug],
          expected: deriveExpectedFromBack(fc.back),
        });
      }
    }

    return [...byId.values()];
  }

  // ── SM-2 state ───────────────────────────────────────────────────────────

  stateFor(id: string): Sm2State {
    return this.state()[id] ?? INITIAL;
  }

  dueIds(pool: readonly Card[], now: string = today()): readonly string[] {
    const s = this.state();
    return pool.filter((c) => isDue(s[c.id] ?? INITIAL, now)).map((c) => c.id);
  }

  // Returns next due card from pool, in oldest-due-first order. Untouched
  // cards (no state yet) come last after all touched-but-due cards.
  nextDue(pool: readonly Card[], now: string = today()): Card | null {
    const s = this.state();
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
    const prev = this.state()[id] ?? INITIAL;
    const next = rate(prev, rating);
    const map = { ...this.state(), [id]: next };
    this.state.set(map);
    void idbSet(STATE_KEY, map);
    this.progress.record(1);
  }

  // Forget a single card's SM-2 state — next time it appears, it's treated
  // as fresh. Useful when a card is 'stuck' on a very long interval.
  resetCard(id: string): void {
    const prev = this.state();
    if (!(id in prev)) return;
    const map: StateMap = { ...prev };
    delete map[id];
    this.state.set(map);
    void idbSet(STATE_KEY, map);
  }

  resetAll(): void {
    this.state.set({});
    void idbSet(STATE_KEY, {});
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
    const next: DailyState =
      direction === 'target-learner'
        ? { ...base, target_learner: base.target_learner + 1 }
        : { ...base, learner_target: base.learner_target + 1 };
    this._daily.set(next);
    void idbSet(DAILY_KEY, next);
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
    const next: DailyState = { ...base, pairs: base.pairs + 1 };
    this._daily.set(next);
    void idbSet(DAILY_KEY, next);
    this.progress.record(PAIRS_PER_ROUND); // round = N pair matches
  }

  // Cards usable on the pairs board: vocab cards in it→uk direction (we need
  // both sides, so AI flashcards that only have front+back without
  // `expected` are filtered out).
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
    // Fisher-Yates shuffle, take first n
    const arr = [...eligible];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
  }

  // Pure read. This is reached from computed() chains in the flashcards
  // component (dailyRemaining → current), and Angular forbids signal writes
  // inside a computed (NG0600) — the previous version reset the signal here
  // and threw the first time a session crossed midnight (issue #66). After a
  // rollover it just reports a fresh counter; incrementDaily/incrementPairs
  // build on that fresh value and persist it, so the stored record catches
  // up on the next write.
  private currentDaily(): DailyState {
    const d = this._daily();
    return d.date === today() ? d : emptyDaily();
  }

  // Persistence is handled by ../lib/storage (IndexedDB via idb-keyval).
  // See initState/initDaily above for the load + one-time migration path,
  // and the various mutators for the fire-and-forget writes.
}

function dedupe<T>(arr: readonly T[]): readonly T[] {
  return [...new Set(arr)];
}

// Normalize a string for forgiving typed-answer comparison: lowercase, trim,
// strip combining diacritics, unify apostrophe variants, collapse whitespace.
// Italian beginners shouldn't be penalized for missing è vs e, curly vs
// straight apostrophe, or extra spaces.
export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`ʼ]/g, "'")
    .trim()
    .replace(/\s+/g, ' ');
}

// Italian article at start of phrase. Matches definite (il, lo, la, l', i, gli,
// le) and indefinite (un, uno, una, un'). Apostrophe forms eat the apostrophe;
// space-followed forms eat the trailing space.
const ARTICLE_RE = /^(?:l['’]|un['’]|(?:gli|uno|una|il|lo|la|le|un|i)\s+)/i;

function stripArticle(s: string): string {
  const out = s.replace(ARTICLE_RE, '');
  // Don't strip away the whole word — if the answer IS an article entry, keep it.
  return out.trim() ? out : s;
}

// Return the leading Italian article of s (with trailing space/apostrophe), or
// null if there is none. Used to detect wrong-article (gender) mistakes.
function leadingArticle(s: string): string | null {
  const m = s.match(ARTICLE_RE);
  return m ? m[0].trim() : null;
}

// Canonical lowercase form for comparing two articles. Curly/straight
// apostrophe are unified so "l'" (curly) and "l'" compare equal, but distinct
// articles ("il" vs "lo", "un" vs "una", "l'" vs "la") remain distinct.
function articleKey(art: string): string {
  return art.toLowerCase().replace(/[’‘`ʼ]/g, "'");
}

// Drop parenthetical hints used in vocab translations to flag gender/notes:
// "проблема (чоловічий рід!)" → "проблема".
function stripParens(s: string): string {
  return s
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Expand "X/Y" gender/number variants inside a single segment.
//   bello/a            → [bello/a, bello, bella]   (single-vowel suffix → replace stem's last vowel)
//   questo/a/i/e       → [questo, questa, questi, queste, ...]
//   lui/lei            → [lui/lei, lui, lei]       (non-vowel suffix → treat as alternative)
//   c + e/i            → [c + e/i, c + e, c + i]
// Leaves strings without "/" untouched.
function expandSlashSegment(s: string): string[] {
  if (!s.includes('/')) return [s];
  const out = new Set<string>([s]);
  const parts = s
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return [...out];
  let stem = parts[0];
  out.add(stem);
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts[i];
    const isSingleVowel = /^[aeiouаеиоуяюєїі]$/i.test(suffix);
    if (isSingleVowel && /[aeiouаеиоуяюєїі]$/i.test(stem)) {
      // Italian (and Russian) gender-suffix replacement: stem ends in a vowel,
      // suffix is a single vowel → swap the last vowel.
      const variant = stem.slice(0, -1) + suffix;
      out.add(variant);
      stem = variant; // chain: "questo/a/i/e" → questo, questa, questi, queste
    } else if (isSingleVowel && /[иі]й$/i.test(stem)) {
      // Ukrainian masculine adjective ending "-ий"/"-ій" → drop the ending,
      // append the suffix: щасливий/а → щаслива, щасливий/е → щасливе.
      // Chain after the first drop: subsequent vowel suffixes then follow the
      // standard vowel-swap rule on the new (already vowel-ending) stem, so
      // "гарний/а/е/і" expands to гарна, гарне, гарні.
      const variant = stem.slice(0, -2) + suffix;
      out.add(variant);
      stem = variant;
    } else {
      out.add(suffix);
    }
  }
  return [...out];
}

// All acceptable text forms of an expected answer: the original, parenthetical
// hints stripped, each comma/semicolon/" / "-separated meaning, each gender
// slash variant, plus article-stripped versions of each.
function expandForms(expected: string): Set<string> {
  const out = new Set<string>();
  const sources = [expected.trim(), stripParens(expected)];
  for (const src of sources) {
    if (!src) continue;
    out.add(src);
    // Multi-meaning separators: comma, semicolon, or ' / ' (with spaces).
    const parts = src.split(/\s*[,;]\s*|\s+\/\s+/);
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      for (const e of expandSlashSegment(p)) {
        const et = e.trim();
        if (et) out.add(et);
      }
    }
  }
  // Article-stripped variants of every collected form.
  for (const f of [...out]) {
    const stripped = stripArticle(f).trim();
    if (stripped && stripped !== f) out.add(stripped);
  }
  return out;
}

export type TypedResult = 'exact' | 'close' | 'wrong';

export function checkTypedAnswer(typed: string, expected: string): TypedResult {
  if (!typed.trim()) return 'wrong';
  const forms = expandForms(expected);
  const t = typed.trim();

  // Tier 1: typed matches a form verbatim → 'exact'.
  if (forms.has(t)) return 'exact';

  // Precompute normalized lookup once — reused by Tier 2 and Tier 4.
  const normalized = new Set<string>();
  for (const f of forms) {
    const n = normalizeAnswer(f);
    if (n) normalized.add(n);
  }
  const tn = normalizeAnswer(t);

  // Tier 2: normalized match (case/diacritic/apostrophe differences) → 'close'.
  if (tn && normalized.has(tn)) return 'close';

  // Tier 3: typed with leading article stripped matches a form verbatim.
  //   - If no form had any article, user just added a stray one → 'exact'.
  //   - If typed's article matches one of the forms' articles → 'exact'.
  //   - If typed used a different article (wrong gender/form) → 'close'.
  const tStripped = stripArticle(t).trim();
  if (tStripped && tStripped !== t && forms.has(tStripped)) {
    const typArt = leadingArticle(t);
    if (!typArt) return 'exact';
    const typKey = articleKey(typArt);
    const formArticleKeys = new Set<string>();
    for (const f of forms) {
      const a = leadingArticle(f);
      if (a) formArticleKeys.add(articleKey(a));
    }
    if (formArticleKeys.size === 0) return 'exact';
    return formArticleKeys.has(typKey) ? 'exact' : 'close';
  }

  // Tier 4: normalized match after stripping typed's article → 'close'.
  if (tStripped && tStripped !== t) {
    const tns = normalizeAnswer(tStripped);
    if (tns && normalized.has(tns)) return 'close';
  }

  return 'wrong';
}
