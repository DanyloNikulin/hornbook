import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiService } from './api.service';
import { ProgressStore } from './progress-store.service';
import { ProgressDrafts } from './progress-drafts.service';
import { EMPTY_PROGRESS } from '../lib/schema';
import type { ProgressView } from '../lib/api-types';
import type { ProgressDraftT } from '../lib/progress-draft';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const view = (revision = 'r0'): ProgressView => ({
  ...structuredClone(EMPTY_PROGRESS),
  revision,
  journalKey: 'journal',
});
let get: ReturnType<typeof vi.fn>;
let put: ReturnType<typeof vi.fn>;
let drafts: Map<string, ProgressDraftT>;
function setup(): ProgressStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: { get, put } },
      {
        provide: ProgressDrafts,
        useValue: {
          read: (_journal: string, id: string) => drafts.get(id) ?? null,
          write: (_journal: string, id: string, value: ProgressDraftT | null) => {
            if (value) drafts.set(id, structuredClone(value));
            else drafts.delete(id);
          },
        },
      },
    ],
  });
  return TestBed.inject(ProgressStore);
}
beforeEach(() => {
  get = vi.fn().mockResolvedValue(view());
  put = vi.fn().mockResolvedValue(view('r1'));
  drafts = new Map();
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

describe('progress ownership and acknowledgement', () => {
  it('keeps valid server progress available when a local draft cannot be read', async () => {
    get.mockResolvedValue({ ...view(), activity: { '2026-09-05': 4 } });
    const store = setup();
    const storage = TestBed.inject(ProgressDrafts);
    vi.spyOn(storage, 'read').mockImplementation(() => {
      throw new Error('Local storage denied');
    });
    const write = vi.spyOn(storage, 'write').mockImplementation(() => {
      throw new Error('Local storage denied');
    });
    await store.load('es-en');
    expect(store.state()).toBe('ready');
    expect(store.loadError()).toBeNull();
    expect(store.activity()).toEqual({ '2026-09-05': 4 });
    expect(store.canStudy()).toBe(false);
    expect(store.notices()[0].draftRecovery).toBe(true);
    store.setActivity({ '2026-09-05': 99 });
    expect(write).not.toHaveBeenCalled();
    await store.retry('es-en');
    expect(store.notices()[0].draftRecovery).toBe(true);
    await store.useSaved('es-en');
    expect(store.canStudy()).toBe(true);
    expect(store.notices()[0].draftDisabled).toBe(true);
    expect(store.activity()).toEqual({ '2026-09-05': 4 });
    store.setActivity({ '2026-09-05': 5 });
    await store.flush();
    expect(put.mock.calls[0][1].activity).toEqual({ '2026-09-05': 5 });
    expect(store.dirty()).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('retains an unreadable draft when fetching the chosen saved copy fails', async () => {
    const store = setup();
    const storage = TestBed.inject(ProgressDrafts);
    vi.spyOn(storage, 'read').mockImplementation(() => {
      throw new Error('Corrupt draft');
    });
    const write = vi.spyOn(storage, 'write');
    await store.load('es-en');
    get.mockRejectedValue(new Error('offline'));
    await store.useSaved('es-en');
    expect(store.canStudy()).toBe(false);
    expect(store.notices()[0].draftRecovery).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('does not fail a server load when deleting an already acknowledged draft fails', async () => {
    drafts.set('es-en', { revision: 'r0', snapshot: structuredClone(EMPTY_PROGRESS) });
    const store = setup();
    vi.spyOn(TestBed.inject(ProgressDrafts), 'write').mockImplementation(() => {
      throw new Error('denied');
    });
    await store.load('es-en');
    expect(store.state()).toBe('ready');
    expect(store.canStudy()).toBe(true);
    expect(store.loadError()).toBeNull();
    expect(store.notices()[0].draftRecovery).toBe(false);
  });
  it('keeps an in-memory copy and warns on close if both draft storage and saving fail', async () => {
    const store = setup();
    await store.load('es-en');
    vi.spyOn(TestBed.inject(ProgressDrafts), 'write').mockImplementation(() => {
      throw new Error('disk full');
    });
    put.mockRejectedValue(new Error('offline'));
    store.setActivity({ '2026-09-04': 8 });
    await store.flush();
    expect(store.dirty()).toBe(true);
    expect(JSON.parse(store.exportPending('es-en')).activity['2026-09-04']).toBe(8);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it('serializes explicit conflict recovery and blocks edits until the chosen saved copy arrives', async () => {
    const store = setup();
    await store.load('es-en');
    put.mockRejectedValue(new ApiError(409, 'changed'));
    store.setActivity({ '2026-09-04': 8 });
    await store.flush();
    const pending = deferred<ProgressView>();
    get.mockReturnValue(pending.promise);
    const first = store.useSaved('es-en');
    await store.useSaved('es-en');
    await store.load('es-en');
    store.setActivity({ '2026-09-04': 99 });
    expect(get).toHaveBeenCalledTimes(2);
    pending.resolve({ ...view('r2'), activity: { '2026-09-04': 7 } });
    await first;
    expect(store.activity()).toEqual({ '2026-09-04': 7 });
  });
  it('flush includes a mutation made while an idle flush is settling', async () => {
    const pending = deferred<ProgressView>();
    put.mockReturnValue(pending.promise);
    const store = setup();
    await store.load('es-en');
    const idle = store.flush();
    store.setActivity({ '2026-09-04': 1 });
    let finished = false;
    const flush = store.flush().then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1), { timeout: 100, interval: 1 });
    expect(finished).toBe(false);
    pending.resolve(view('r1'));
    await idle;
    await flush;
    expect(store.dirty()).toBe(false);
  });
  it('retrying a failed inactive section does not change mutation ownership', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    const store = setup();
    await store.load('es-en');
    await store.load('it-en');
    await store.retry('es-en');
    store.setActivity({ '2026-09-04': 2 });
    await store.flush();
    expect(store.sectionId()).toBe('it-en');
    expect(put.mock.calls[0][0]).toBe('/api/sections/it-en/progress');
  });
  it('does not accept mutations before a successful load or after a failed load', async () => {
    get.mockRejectedValue(new Error('offline'));
    const store = setup();
    store.setActivity({ '2026-09-04': 99 });
    await store.load('es-en');
    store.setActivity({ '2026-09-04': 99 });
    await store.flush();
    expect(store.state()).toBe('failed');
    expect(store.snapshot()).toEqual(EMPTY_PROGRESS);
    expect(put).not.toHaveBeenCalled();
    expect(drafts.size).toBe(0);
  });
  it('ignores an old failed response after another section loads', async () => {
    const first = deferred<ProgressView>();
    get
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ...view(), activity: { '2026-09-04': 4 } });
    const store = setup();
    const a = store.load('es-en');
    await store.load('it-en');
    first.reject(new Error('old failure'));
    await a;
    expect(store.sectionId()).toBe('it-en');
    expect(store.loadError()).toBeNull();
    expect(store.activity()).toEqual({ '2026-09-04': 4 });
  });
  it('serializes changed snapshots and keeps flush pending until the last acknowledgement', async () => {
    const first = deferred<ProgressView>();
    const second = deferred<ProgressView>();
    put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = setup();
    await store.load('es-en');
    store.setActivity({ '2026-09-04': 1 });
    const flushing = store.flush();
    store.setActivity({ '2026-09-04': 2 });
    let finished = false;
    const otherFlush = store.flush().then(() => {
      finished = true;
    });
    expect(put).toHaveBeenCalledTimes(1);
    first.resolve(view('r1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][1]).toMatchObject({ revision: 'r1', activity: { '2026-09-04': 2 } });
    expect(finished).toBe(false);
    second.resolve(view('r2'));
    await flushing;
    await otherFlush;
    expect(store.dirty()).toBe(false);
    expect(drafts.size).toBe(0);
  });
  it('retains failed saves across section switches and retries each original section', async () => {
    put.mockRejectedValueOnce(new Error('offline'));
    const store = setup();
    await store.load('es-en');
    store.setActivity({ '2026-09-04': 3 });
    expect(await store.flush()).toBe(false);
    expect(drafts.get('es-en')?.snapshot.activity).toEqual({ '2026-09-04': 3 });
    await store.load('it-en');
    await store.flush();
    expect(put.mock.calls[1][0]).toBe('/api/sections/es-en/progress');
    expect(store.activity()).toEqual({});
    await store.load('es-en');
    expect(store.activity()).toEqual({ '2026-09-04': 3 });
  });
  it('restores a pending draft after restart and preserves it on a stale-write conflict', async () => {
    drafts.set('es-en', {
      revision: 'r0',
      snapshot: { ...structuredClone(EMPTY_PROGRESS), activity: { '2026-09-04': 7 } },
    });
    get.mockResolvedValue(view('r2'));
    const store = setup();
    await store.load('es-en');
    expect(store.activity()).toEqual({ '2026-09-04': 7 });
    expect(store.notices()[0].conflict).toBe(true);
    expect(await store.flush()).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(drafts.has('es-en')).toBe(true);
    expect(JSON.parse(store.exportPending('es-en')).activity).toEqual({ '2026-09-04': 7 });
  });
  it('retains a rejected stale snapshot until the user explicitly chooses saved progress', async () => {
    put.mockRejectedValue(new ApiError(409, 'changed'));
    const store = setup();
    await store.load('es-en');
    store.setActivity({ '2026-09-04': 7 });
    await store.flush();
    expect(store.dirty()).toBe(true);
    expect(store.notices()[0].conflict).toBe(true);
    get.mockResolvedValue({ ...view('r2'), activity: { '2026-09-04': 9 } });
    await store.useSaved('es-en');
    expect(store.activity()).toEqual({ '2026-09-04': 9 });
    expect(drafts.size).toBe(0);
  });
  it('warns before closing with pending browser progress and clears the warning after saving', async () => {
    const store = setup();
    await store.load('es-en');
    store.setActivity({ '2026-09-04': 1 });
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await store.flush();
    const saved = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });
  it('blocks a quarantined history until the user starts fresh explicitly', async () => {
    get.mockResolvedValue({ ...view(), recovery: '_progress.corrupt-fixture.json' });
    const store = setup();
    await store.load('es-en');
    store.setActivity({ '2026-09-04': 1 });
    expect(store.state()).toBe('failed');
    expect(put).not.toHaveBeenCalled();
    await store.startFresh('es-en');
    expect(put.mock.calls[0][1]).toMatchObject({ revision: 'r0', recover: true, activity: {} });
    expect(store.state()).toBe('ready');
  });
});
