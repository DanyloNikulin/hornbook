import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import { CardsService, DAILY_LIMIT, PAIRS_LIMIT } from './cards.service';
import { ProgressStore } from './progress-store.service';
import { ApiService } from './api.service';
import { SectionService } from './section.service';
import { EMPTY_PROGRESS } from '../lib/schema';

// CardsService reads and writes learner state through ProgressStore, which
// talks to the API. Stub the API so nothing touches the network; the store
// still debounces a PUT, which the tests flush explicitly.
function freshService(): { svc: CardsService; store: ProgressStore; put: ReturnType<typeof vi.fn> } {
  const put = vi.fn().mockResolvedValue({});
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: { get: vi.fn().mockResolvedValue(EMPTY_PROGRESS), put } },
      { provide: SectionService, useValue: { id: () => 'es-en', apiBase: () => '/api/sections/es-en' } },
    ],
  });
  const store = TestBed.inject(ProgressStore);
  store.sectionId.set('es-en');
  return { svc: TestBed.inject(CardsService), store, put };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 2, 23, 55, 0)); // 2026-09-02 23:55 local
});
afterEach(() => vi.useRealTimers());

describe('CardsService — daily counter', () => {
  it('counts increments per direction within the same day and persists them', async () => {
    const { svc, store, put } = freshService();
    svc.incrementDaily('target-learner');
    svc.incrementDaily('target-learner');
    svc.incrementDaily('learner-target');
    expect(svc.dailyDone('target-learner')).toBe(2);
    expect(svc.dailyDone('learner-target')).toBe(1);
    expect(svc.dailyRemaining('target-learner')).toBe(DAILY_LIMIT - 2);
    expect(store.daily()).toEqual({ date: '2026-09-02', target_learner: 2, learner_target: 1, pairs: 0 });

    await store.flush();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe('/api/sections/es-en/progress');
    expect(put.mock.calls[0][1]).toMatchObject({ daily: { target_learner: 2 } });
  });

  it('reads a fresh counter after midnight from inside a computed', () => {
    const { svc, store } = freshService();
    svc.incrementDaily('target-learner');
    svc.incrementDaily('target-learner');
    svc.incrementPairs();

    vi.setSystemTime(new Date(2026, 8, 3, 0, 1, 0)); // 2026-09-03 00:01 local

    // Same shape flashcards.component uses: dailyRemaining → current are
    // computed()s. A signal write from inside would throw NG0600.
    const remaining = computed(() => svc.dailyRemaining('target-learner'));
    const pairsRemaining = computed(() => svc.dailyPairsRemaining());
    expect(() => remaining()).not.toThrow();
    expect(remaining()).toBe(DAILY_LIMIT);
    expect(pairsRemaining()).toBe(PAIRS_LIMIT);
    expect(svc.dailyDone('target-learner')).toBe(0);

    // A read must not mutate stored state; yesterday's record stays until a
    // write replaces it.
    expect(store.daily()?.date).toBe('2026-09-02');

    svc.incrementDaily('target-learner');
    expect(store.daily()).toEqual({ date: '2026-09-03', target_learner: 1, learner_target: 0, pairs: 0 });
  });
});

describe('CardsService — SM-2 state', () => {
  // INITIAL.due is computed once at module load from the real clock, so this
  // block runs on real time rather than the frozen date above.
  beforeEach(() => vi.useRealTimers());

  it('rates, resets and reports due cards through the store', () => {
    const { svc, store } = freshService();
    const todayKey = new Date().toISOString().slice(0, 10);
    const card = {
      id: 'c1',
      source_ids: ['c1'],
      front: 'hola',
      back: 'hello',
      direction: 'target-learner' as const,
      source: 'vocab' as const,
      type: 'word' as const,
      tags: [],
      lessons: ['greetings'],
      expected: 'hello',
    };
    expect(svc.dueIds([card])).toEqual(['c1']);
    expect(svc.isNew(card.id)).toBe(true);
    expect(svc.newCount([card])).toBe(1);
    svc.rateCard('c1', 5);
    expect(store.sm2()['c1']?.repetitions).toBe(1);
    expect(svc.dueIds([card])).toEqual([]);
    expect(svc.isNew(card.id)).toBe(false);
    expect(svc.newCount([card])).toBe(0);
    expect(Object.values(store.activity())).toEqual([1]);
    expect(Object.keys(store.activity())[0]?.slice(0, 4)).toBe(todayKey.slice(0, 4));
    svc.resetCard('c1');
    expect(store.sm2()['c1']).toBeUndefined();
  });
});
