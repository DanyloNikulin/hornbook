// fake-indexeddb/auto installs an in-memory IndexedDB on globalThis so
// idb-keyval can be exercised under vitest's jsdom env (which lacks IDB)
// and under plain node. Imported for side effects.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as idb from 'idb-keyval';
import { ProgressService } from './progress.service';

const KEY = 'progress';

// `localStorage` only exists under jsdom; we run tests through both
// `ng test` (jsdom) and plain `npx vitest run` (node). The legacy
// localStorage→IDB migration is only meaningful with a real localStorage,
// so those specific tests skip themselves when absent. The IDB-only tests
// always run.
const hasLS = typeof localStorage !== 'undefined';
function lsSet(k: string, v: string): void {
  if (hasLS) localStorage.setItem(k, v);
}
function lsGet(k: string): string | null {
  return hasLS ? localStorage.getItem(k) : null;
}
function lsClear(): void {
  if (hasLS) localStorage.clear();
}

// Brand-new IDB and a clean localStorage for every test. The pre-migration
// service had a TestBed shim; that's gone — we just construct the service
// directly because it has no Angular-injected dependencies.
async function freshService(): Promise<ProgressService> {
  await idb.clear();
  const svc = new ProgressService();
  await svc.ready;
  return svc;
}

beforeEach(async () => {
  lsClear();
  await idb.clear();
});

describe('ProgressService — streakDays', () => {
  it('returns 0 when no activity recorded', async () => {
    const svc = await freshService();
    expect(svc.streakDays('2026-05-23')).toBe(0);
  });

  it('counts consecutive days ending today', async () => {
    await idb.set(KEY, {
      '2026-05-21': 5,
      '2026-05-22': 3,
      '2026-05-23': 7,
    });
    const svc = new ProgressService();
    await svc.ready;
    expect(svc.streakDays('2026-05-23')).toBe(3);
  });

  it('grace day: if today is empty but yesterday had activity, streak still counts', async () => {
    await idb.set(KEY, {
      '2026-05-21': 5,
      '2026-05-22': 3,
    });
    const svc = new ProgressService();
    await svc.ready;
    expect(svc.streakDays('2026-05-23')).toBe(2);
  });

  it('returns 0 if today AND yesterday both empty (streak broken)', async () => {
    await idb.set(KEY, {
      '2026-05-10': 100,
      '2026-05-11': 50,
    });
    const svc = new ProgressService();
    await svc.ready;
    expect(svc.streakDays('2026-05-23')).toBe(0);
  });
});

describe('ProgressService — heatmap', () => {
  it('returns N weeks × 7 days ending on the given date', async () => {
    const svc = await freshService();
    const grid = svc.heatmap(4, '2026-05-23');
    expect(grid.length).toBe(4);
    for (const week of grid) expect(week.length).toBe(7);
    expect(grid[3][6].date).toBe('2026-05-23');
  });

  it('fills counts from activity map; zero where empty', async () => {
    await idb.set(KEY, { '2026-05-22': 5, '2026-05-23': 9 });
    const svc = new ProgressService();
    await svc.ready;
    const grid = svc.heatmap(2, '2026-05-23');
    const flat = grid.flat();
    expect(flat.find((c) => c.date === '2026-05-22')?.count).toBe(5);
    expect(flat.find((c) => c.date === '2026-05-23')?.count).toBe(9);
    expect(flat.filter((c) => c.count > 0).length).toBe(2);
  });
});

describe('ProgressService — record', () => {
  it('ignores non-positive counts', async () => {
    const svc = await freshService();
    svc.record(0);
    svc.record(-5);
    expect(Object.keys(svc.activity()).length).toBe(0);
  });

  it('accumulates same-day calls', async () => {
    const svc = await freshService();
    svc.record(3);
    svc.record(5);
    const total = Object.values(svc.activity()).reduce((s, n) => s + n, 0);
    expect(total).toBe(8);
  });

  it('persists writes to IndexedDB', async () => {
    const svc = await freshService();
    svc.record(7);
    // The signal updates synchronously, but the IDB write is fire-and-forget;
    // wait a microtask before reading back.
    await new Promise((r) => setTimeout(r, 0));
    const stored = (await idb.get<Record<string, number>>(KEY)) ?? {};
    expect(Object.values(stored).reduce((s, n) => s + n, 0)).toBe(7);
  });
});

describe.runIf(hasLS)('ProgressService — localStorage migration', () => {
  it('migrates legacy localStorage data to IndexedDB on first load', async () => {
    lsSet(KEY, JSON.stringify({ '2026-05-20': 10, '2026-05-21': 5 }));
    const svc = new ProgressService();
    await svc.ready;
    expect(svc.activity()['2026-05-20']).toBe(10);
    expect(svc.activity()['2026-05-21']).toBe(5);
    const stored = (await idb.get<Record<string, number>>(KEY)) ?? {};
    expect(stored['2026-05-20']).toBe(10);
    // Legacy key cleaned up
    expect(lsGet(KEY)).toBeNull();
  });

  it('is idempotent: rerun on already-migrated store is a no-op', async () => {
    lsSet(KEY, JSON.stringify({ '2026-05-20': 10 }));
    await new ProgressService().ready;
    expect(lsGet(KEY)).toBeNull();

    // Simulate a stray localStorage entry written again (e.g. by an older
    // tab still open). Re-init must NOT clobber the existing IDB data.
    await idb.set(KEY, { '2026-05-20': 99 });
    lsSet(KEY, JSON.stringify({ '2026-05-20': 1 }));
    const svc2 = new ProgressService();
    await svc2.ready;
    expect(svc2.activity()['2026-05-20']).toBe(99);
  });

  it('no-op when localStorage is empty and IDB is empty', async () => {
    const svc = new ProgressService();
    await svc.ready;
    expect(svc.activity()).toEqual({});
    expect(await idb.get(KEY)).toBeUndefined();
  });

  it('drops malformed localStorage entries instead of getting stuck on them', async () => {
    lsSet(KEY, 'not-json{');
    const svc = new ProgressService();
    await svc.ready;
    expect(svc.activity()).toEqual({});
    // Bad legacy entry is cleaned up so we don't keep parsing it.
    expect(lsGet(KEY)).toBeNull();
  });
});
