import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ProgressService } from './progress.service';
import { ProgressStore } from './progress-store.service';
import { ApiService } from './api.service';
import { EMPTY_PROGRESS } from '../lib/schema';

interface Harness {
  svc: ProgressService;
  store: ProgressStore;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

function harness(initialActivity: Record<string, number> = {}): Harness {
  const get = vi.fn().mockResolvedValue({ ...EMPTY_PROGRESS, activity: initialActivity });
  const put = vi.fn().mockResolvedValue({});
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { get, put } }] });
  const store = TestBed.inject(ProgressStore);
  return { svc: TestBed.inject(ProgressService), store, get, put };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('ProgressStore — load and save', () => {
  it('loads a section, exposes its activity, and PUTs after a write', async () => {
    const h = harness({ '2026-05-23': 4 });
    await h.store.load('es-en');
    expect(h.get).toHaveBeenCalledWith('/api/sections/es-en/progress');
    expect(h.svc.activity()).toEqual({ '2026-05-23': 4 });

    h.svc.record(2);
    await h.store.flush();
    expect(h.put).toHaveBeenCalledTimes(1);
    const [path, body] = h.put.mock.calls[0] as [string, { activity: Record<string, number> }];
    expect(path).toBe('/api/sections/es-en/progress');
    expect(Object.values(body.activity).reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('resets state when switching sections and records a load error', async () => {
    const h = harness({ '2026-05-23': 4 });
    await h.store.load('es-en');
    h.get.mockRejectedValueOnce(new Error('HTTP 503: down'));
    await h.store.load('it-en');
    expect(h.store.activity()).toEqual({});
    expect(h.store.loadError()).toContain('503');
  });

  it('coalesces rapid writes into one PUT', async () => {
    const h = harness();
    await h.store.load('es-en');
    h.svc.record(1);
    h.svc.record(1);
    h.svc.record(1);
    await h.store.flush();
    expect(h.put).toHaveBeenCalledTimes(1);
  });
});

describe('ProgressService — streakDays', () => {
  it('returns 0 when no activity recorded', () => {
    const { svc } = harness();
    expect(svc.streakDays('2026-05-23')).toBe(0);
  });

  it('counts consecutive days ending today', () => {
    const { svc, store } = harness();
    store.activity.set({ '2026-05-21': 5, '2026-05-22': 3, '2026-05-23': 7 });
    expect(svc.streakDays('2026-05-23')).toBe(3);
  });

  it('grace day: if today is empty but yesterday had activity, streak still counts', () => {
    const { svc, store } = harness();
    store.activity.set({ '2026-05-21': 5, '2026-05-22': 3 });
    expect(svc.streakDays('2026-05-23')).toBe(2);
  });

  it('a gap of one day breaks the streak', () => {
    const { svc, store } = harness();
    store.activity.set({ '2026-05-20': 5, '2026-05-22': 3, '2026-05-23': 1 });
    expect(svc.streakDays('2026-05-23')).toBe(2);
  });

  it('two empty days means no streak', () => {
    const { svc, store } = harness();
    store.activity.set({ '2026-05-20': 5 });
    expect(svc.streakDays('2026-05-23')).toBe(0);
  });
});

describe('ProgressService — record', () => {
  it('accumulates within a day and ignores non-positive counts', () => {
    const { svc, store } = harness();
    svc.record(2);
    svc.record(3);
    svc.record(0);
    svc.record(-1);
    const values = Object.values(store.activity());
    expect(values).toEqual([5]);
  });
});

describe('ProgressService — heatmap', () => {
  it('returns weeks × 7 cells ending on the given day', () => {
    const { svc, store } = harness();
    store.activity.set({ '2026-05-23': 2, '2026-05-01': 1 });
    const grid = svc.heatmap(8, '2026-05-23');
    expect(grid).toHaveLength(8);
    expect(grid.every((w) => w.length === 7)).toBe(true);
    const last = grid[7][6];
    expect(last).toEqual({ date: '2026-05-23', count: 2 });
    const first = grid[0][0];
    expect(first.date).toBe('2026-03-29');
    const flat = grid.flat();
    expect(flat.find((c) => c.date === '2026-05-01')?.count).toBe(1);
  });
});
