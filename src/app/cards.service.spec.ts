// fake-indexeddb/auto installs an in-memory IndexedDB on globalThis so
// idb-keyval works under vitest's jsdom env. Imported for side effects.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import * as idb from 'idb-keyval';
import { CardsService, DAILY_LIMIT, PAIRS_LIMIT } from './cards.service';

const DAILY_KEY = 'lj-flashcards-daily';

// CardsService injects Lessons/Vocab/Progress services, so it needs an
// injection context; none of them touch the network at construction time.
async function freshService(): Promise<CardsService> {
  await idb.clear();
  TestBed.resetTestingModule();
  const svc = TestBed.inject(CardsService);
  await svc.ready;
  return svc;
}

// Only fake `Date` — faking timers as well would stall fake-indexeddb's
// internal scheduling and every idb call would hang.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 2, 23, 55, 0)); // 2026-09-02 23:55 local
});
afterEach(() => vi.useRealTimers());

describe('CardsService — daily counter', () => {
  it('counts increments per direction within the same day', async () => {
    const svc = await freshService();
    svc.incrementDaily('target-learner');
    svc.incrementDaily('target-learner');
    svc.incrementDaily('learner-target');
    expect(svc.dailyDone('target-learner')).toBe(2);
    expect(svc.dailyDone('learner-target')).toBe(1);
    expect(svc.dailyRemaining('target-learner')).toBe(DAILY_LIMIT - 2);
    expect(await idb.get(DAILY_KEY)).toEqual({ date: '2026-09-02', target_learner: 2, learner_target: 1, pairs: 0 });
  });

  it('reads a fresh counter after midnight from inside a computed (issue #66)', async () => {
    const svc = await freshService();
    svc.incrementDaily('target-learner');
    svc.incrementDaily('target-learner');
    svc.incrementPairs();

    vi.setSystemTime(new Date(2026, 8, 3, 0, 1, 0)); // 2026-09-03 00:01 local

    // This is the shape flashcards.component uses (dailyRemaining → current
    // are computed()s). Before the fix currentDaily() wrote a signal here
    // and Angular threw NG0600.
    const remaining = computed(() => svc.dailyRemaining('target-learner'));
    const pairsRemaining = computed(() => svc.dailyPairsRemaining());
    expect(() => remaining()).not.toThrow();
    expect(remaining()).toBe(DAILY_LIMIT);
    expect(pairsRemaining()).toBe(PAIRS_LIMIT);
    expect(svc.dailyDone('target-learner')).toBe(0);

    // A read must not mutate stored state; yesterday's record stays until a
    // write rolls it over.
    expect(svc.daily()).toEqual({ date: '2026-09-02', target_learner: 2, learner_target: 0, pairs: 1 });
    expect(await idb.get(DAILY_KEY)).toEqual({ date: '2026-09-02', target_learner: 2, learner_target: 0, pairs: 1 });
  });

  it('persists the rolled-over counter on the next increment', async () => {
    const svc = await freshService();
    svc.incrementDaily('target-learner');

    vi.setSystemTime(new Date(2026, 8, 3, 0, 1, 0));
    svc.incrementDaily('learner-target');

    const expected = { date: '2026-09-03', target_learner: 0, learner_target: 1, pairs: 0 };
    expect(svc.daily()).toEqual(expected);
    expect(await idb.get(DAILY_KEY)).toEqual(expected);
  });

  it('discards a persisted counter from a previous day on load', async () => {
    await idb.clear();
    await idb.set(DAILY_KEY, { date: '2026-09-01', target_learner: 7, learner_target: 3, pairs: 2 });
    TestBed.resetTestingModule();
    const svc = TestBed.inject(CardsService);
    await svc.ready;
    expect(svc.dailyDone('target-learner')).toBe(0);
    expect(svc.dailyPairsDone()).toBe(0);
  });
});
