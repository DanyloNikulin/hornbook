import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import * as idb from 'idb-keyval';
import { QuizResultsService } from './quiz-results.service';
import { ProgressService } from './progress.service';
import { today } from '../lib/sm2';

const KEY = 'quiz-results';

async function freshService(): Promise<QuizResultsService> {
  TestBed.resetTestingModule();
  const svc = TestBed.inject(QuizResultsService);
  await svc.ready;
  return svc;
}

beforeEach(async () => {
  await idb.clear();
});

describe('QuizResultsService', () => {
  it('returns null for a lesson with no attempts', async () => {
    const svc = await freshService();
    expect(svc.forLesson('nope')).toBeNull();
  });

  it('records the first attempt and persists it', async () => {
    const svc = await freshService();
    const r = svc.record('andare', 3, 5);
    expect(r).toMatchObject({ best_score: 3, total: 5, attempts: 1 });
    expect(r.last_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(svc.forLesson('andare')).toEqual(r);
    expect(await idb.get(KEY)).toEqual({ andare: r });
  });

  it('keeps the best score, counts attempts, and updates total to the latest run', async () => {
    const svc = await freshService();
    svc.record('andare', 4, 5);
    svc.record('andare', 2, 5);
    const r = svc.record('andare', 3, 6);
    expect(r.best_score).toBe(4);
    expect(r.attempts).toBe(3);
    expect(r.total).toBe(6);
  });

  it('keeps results for different lessons independent', async () => {
    const svc = await freshService();
    svc.record('a', 1, 3);
    svc.record('b', 3, 3);
    expect(svc.forLesson('a')?.best_score).toBe(1);
    expect(svc.forLesson('b')?.best_score).toBe(3);
  });

  it('counts each submission as N activities in ProgressService', async () => {
    const svc = await freshService();
    const progress = TestBed.inject(ProgressService);
    await progress.ready;
    svc.record('a', 2, 4);
    svc.record('a', 4, 4);
    expect(progress.activity()[today()]).toBe(8);
  });

  it('loads persisted results on construction', async () => {
    await idb.set(KEY, { fare: { best_score: 5, total: 5, attempts: 2, last_at: '2026-09-01T10:00:00.000Z' } });
    const svc = await freshService();
    expect(svc.forLesson('fare')).toEqual({ best_score: 5, total: 5, attempts: 2, last_at: '2026-09-01T10:00:00.000Z' });
  });
});
