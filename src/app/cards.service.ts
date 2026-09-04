import { Injectable, computed, inject } from '@angular/core';
import { ProgressService } from './progress.service';
import { ProgressStore } from './progress-store.service';
import { SectionService } from './section.service';
import { ApiService } from './api.service';
import { DerivedCard, type DailyStateT } from '../lib/schema';
import { INITIAL, type Sm2State, type Rating, rate, today, isDue } from '../lib/sm2';
import { articleRegexFor } from '../lib/articles';

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

  // Per-section caches. Keys are `${section}` and `${section}/${slug}`.
  private readonly allCache = new Map<string, Promise<readonly Card[]>>();
  private readonly lessonCache = new Map<string, Promise<readonly Card[]>>();

  readonly daily = computed<DailyStateT>(() => this.store.daily() ?? emptyDaily());

  /** Drop cached pools (after a lesson was saved). */
  invalidate(): void {
    const id = this.section.id();
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
      this.allCache.delete(id);
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
        this.lessonCache.delete(key);
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

// Normalize a string for forgiving typed-answer comparison: lowercase, trim,
// strip combining diacritics, unify apostrophe variants, collapse whitespace.
// Beginners shouldn't be penalized for a missing diacritic (è vs e), curly vs
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

// Article handling is per target language (see ../lib/articles.ts). The
// regex matches a leading article: elided forms (l', un') eat the apostrophe,
// space-followed forms eat the trailing whitespace. `null` means the target
// language has no article table and articles are never stripped.
function stripArticle(s: string, re: RegExp | null): string {
  if (!re) return s;
  const out = s.replace(re, '');
  // Don't strip away the whole word — if the answer IS an article entry, keep it.
  return out.trim() ? out : s;
}

// Return the leading article of s (with trailing space/apostrophe), or null if
// there is none. Used to detect wrong-article (gender/number) mistakes.
function leadingArticle(s: string, re: RegExp | null): string | null {
  if (!re) return null;
  const m = s.match(re);
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
      // Romance/Slavic gender-suffix replacement: stem ends in a vowel,
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
function expandForms(expected: string, articleRe: RegExp | null): Set<string> {
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
    const stripped = stripArticle(f, articleRe).trim();
    if (stripped && stripped !== f) out.add(stripped);
  }
  return out;
}

export type TypedResult = 'exact' | 'close' | 'wrong';

/**
 * Grade a typed answer against the expected text. `lang` is the ISO 639-1
 * code of the target language (journal.config.json → pair.target); it selects
 * the article table used to forgive a missing/extra article and to flag a
 * wrong one. Pass an unknown code (or omit it) to disable article handling.
 */
export function checkTypedAnswer(typed: string, expected: string, lang = ''): TypedResult {
  if (!typed.trim()) return 'wrong';
  const articleRe = articleRegexFor(lang);
  const forms = expandForms(expected, articleRe);
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
  const tStripped = stripArticle(t, articleRe).trim();
  if (tStripped && tStripped !== t && forms.has(tStripped)) {
    const typArt = leadingArticle(t, articleRe);
    if (!typArt) return 'exact';
    const typKey = articleKey(typArt);
    const formArticleKeys = new Set<string>();
    for (const f of forms) {
      const a = leadingArticle(f, articleRe);
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
