import { Injectable, signal } from '@angular/core';
import { z } from 'zod';
import { today } from '../lib/sm2';
import { idbGet, idbSet, migrateFromLocalStorage } from '../lib/storage';

const STORAGE_KEY = 'progress';

type ActivityMap = Record<string, number>;

const ActivityMapSchema = z.record(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.number().int().nonnegative(),
);

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

@Injectable({ providedIn: 'root' })
export class ProgressService {
  // Signal seeded with an empty map; the async load below replaces it once
  // IDB returns. Downstream computed signals (heatmap, streak) re-evaluate
  // automatically when the underlying signal changes, so callers don't need
  // to await anything.
  private readonly _activity = signal<ActivityMap>({});
  readonly activity = this._activity.asReadonly();

  // Promise resolves once the initial load (and any one-time localStorage
  // migration) completes. Exposed for tests; production code rarely needs
  // it because signals already handle the post-load update.
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    // migrateFromLocalStorage returns the value it migrated, so we don't
    // need a second IDB read on first run after deploy.
    const migrated = await migrateFromLocalStorage<unknown>(STORAGE_KEY);
    const raw = migrated !== undefined ? migrated : await idbGet<unknown>(STORAGE_KEY);
    if (raw === undefined) return; // signal already holds the empty default
    const parsed = ActivityMapSchema.safeParse(raw);
    if (parsed.success) this._activity.set(parsed.data);
  }

  // Called by cards/quiz services on any user-initiated action. Multiple calls
  // in the same day accumulate.
  record(n = 1): void {
    if (n <= 0) return;
    const t = today();
    const prev = this._activity();
    const next = { ...prev, [t]: (prev[t] ?? 0) + n };
    this._activity.set(next);
    void idbSet(STORAGE_KEY, next);
  }

  // Consecutive days of activity counting back from today. Grace day: if today
  // has nothing yet but yesterday did, we still consider the streak alive.
  streakDays(now: string = today()): number {
    const a = this._activity();
    let day = now;
    if (!(day in a)) {
      day = addDays(now, -1);
      if (!(day in a)) return 0;
    }
    let streak = 0;
    while (day in a) {
      streak += 1;
      day = addDays(day, -1);
    }
    return streak;
  }

  // weeks × 7 grid of daily counts ending on `now` (today by default).
  // Outer array = weeks (oldest first). Inner = days mon..sun? No — we just
  // anchor to `now` and walk back 7×weeks days; UI is the one that knows the
  // weekday of `now` and rotates if it wants a Mon-anchored layout. Simpler.
  heatmap(weeks = 8, now: string = today()): { date: string; count: number }[][] {
    const a = this._activity();
    const totalDays = weeks * 7;
    const start = addDays(now, -(totalDays - 1));
    const result: { date: string; count: number }[][] = [];
    for (let w = 0; w < weeks; w++) {
      const week: { date: string; count: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = addDays(start, w * 7 + d);
        week.push({ date, count: a[date] ?? 0 });
      }
      result.push(week);
    }
    return result;
  }
}
