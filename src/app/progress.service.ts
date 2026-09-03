import { Injectable, computed, inject } from '@angular/core';
import { today } from '../lib/sm2';
import { ProgressStore } from './progress-store.service';

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Daily activity of the current section (streak, heatmap). State lives in
 * ProgressStore; this service is the calendar arithmetic on top of it.
 */
@Injectable({ providedIn: 'root' })
export class ProgressService {
  private readonly store = inject(ProgressStore);

  readonly activity = computed(() => this.store.activity());

  // Called by cards/quiz services on any user-initiated action. Multiple
  // calls in the same day accumulate.
  record(n = 1): void {
    if (n <= 0) return;
    const t = today();
    const prev = this.store.activity();
    this.store.setActivity({ ...prev, [t]: (prev[t] ?? 0) + n });
  }

  // Consecutive days of activity counting back from today. Grace day: if
  // today has nothing yet but yesterday did, the streak is still alive.
  streakDays(now: string = today()): number {
    const a = this.store.activity();
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

  // weeks × 7 grid of daily counts ending on `now`. Outer array = weeks
  // (oldest first); the UI knows the weekday of `now` and rotates if it wants
  // a Monday-anchored layout.
  heatmap(weeks = 8, now: string = today()): { date: string; count: number }[][] {
    const a = this.store.activity();
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
