// SM-2 spaced repetition algorithm (Piotr Wozniak, SuperMemo 2).
// State per card and the rating handler are intentionally simple: no UI
// concerns, no persistence — Service layer wraps localStorage around it.

export interface Sm2State {
  interval: number; // days until next review
  ef: number; // ease factor, starts at 2.5
  repetitions: number; // consecutive successful recalls
  due: string; // ISO date the card is next due
}

export type Rating = 1 | 2 | 3 | 4 | 5;

export const INITIAL: Sm2State = {
  interval: 0,
  ef: 2.5,
  repetitions: 0,
  due: today(),
};

export function today(now: Date = new Date()): string {
  // Study progress follows the learner's local calendar day. ISO serialization
  // uses UTC and would roll daily limits/streaks over at 01:00 or 02:00 for a
  // learner in Europe/Berlin rather than at local midnight.
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isDue(state: Sm2State, now: string = today()): boolean {
  return state.due <= now;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Rating semantics. Anything below 3 is a lapse (repetitions reset, next
// review tomorrow); 3–5 pass and grow the interval. The ease factor is
// updated by the classic SM-2 formula for every rating, so 2 is punished
// less than 1 but still does not count as a pass. The app currently uses
// only 1 / 3 / 5 (typing result: wrong / close / exact).
//   1 = Again       — lapse, ef −0.54
//   2 = Hard        — lapse, ef −0.32
//   3 = Good        — pass, ef −0.14
//   4 = Easy        — pass, ef −0.02
//   5 = Perfect     — pass, ef +0.10
export function rate(prev: Sm2State, rating: Rating, now: string = today()): Sm2State {
  let { ef, repetitions } = prev;
  let interval: number;

  if (rating < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(prev.interval * ef);
  }

  // SM-2 ease-factor update (clamped to 1.3 min).
  const q = rating;
  ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < 1.3) ef = 1.3;

  return {
    interval,
    ef,
    repetitions,
    due: addDays(now, interval),
  };
}

// Stable card id from front + back. Non-cryptographic FNV-1a-ish, plenty
// of distribution for typical card counts (a few thousand).
//
// Known limitation: front and back are concatenated with no separator, so
// ('ab','c') and ('a','bc') hash to the same id. Adding a separator would
// re-key every card and detach all existing SM-2 progress, so it is
// deliberately left as-is until the stable-content-ID migration re-keys
// cards anyway. build-derived.ts and the runtime share this function, so ids
// are at least consistent between the two.
export function cardId(front: string, back: string): string {
  const s = front + '' + back;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
