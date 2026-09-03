import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { QuizResultsService } from './quiz-results.service';
import { ProgressService } from './progress.service';
import { ProgressStore } from './progress-store.service';
import { ApiService } from './api.service';
import { EMPTY_PROGRESS } from '../lib/schema';
import { today } from '../lib/sm2';

let put: ReturnType<typeof vi.fn>;

function freshService(): QuizResultsService {
  put = vi.fn().mockResolvedValue({});
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ApiService, useValue: { get: vi.fn().mockResolvedValue(EMPTY_PROGRESS), put } }],
  });
  TestBed.inject(ProgressStore).sectionId.set('es-en');
  return TestBed.inject(QuizResultsService);
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('QuizResultsService', () => {
  it('returns null for a lesson with no attempts', () => {
    const svc = freshService();
    expect(svc.forLesson('nope')).toBeNull();
  });

  it('records the first attempt and persists it', async () => {
    const svc = freshService();
    const r = svc.record('andare', 3, 5);
    expect(r).toMatchObject({ best_score: 3, total: 5, attempts: 1 });
    expect(r.last_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(svc.forLesson('andare')).toEqual(r);
    await TestBed.inject(ProgressStore).flush();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toMatchObject({ quiz: { andare: r } });
  });

  it('keeps the best score, counts attempts, and updates total to the latest run', () => {
    const svc = freshService();
    svc.record('andare', 4, 5);
    svc.record('andare', 2, 5);
    const r = svc.record('andare', 3, 6);
    expect(r.best_score).toBe(4);
    expect(r.attempts).toBe(3);
    expect(r.total).toBe(6);
  });

  it('keeps results for different lessons independent', () => {
    const svc = freshService();
    svc.record('a', 1, 3);
    svc.record('b', 3, 3);
    expect(svc.forLesson('a')?.best_score).toBe(1);
    expect(svc.forLesson('b')?.best_score).toBe(3);
  });

  it('counts each submission as N activities in ProgressService', () => {
    const svc = freshService();
    const progress = TestBed.inject(ProgressService);
    svc.record('a', 2, 4);
    svc.record('a', 4, 4);
    expect(progress.activity()[today()]).toBe(8);
  });
});
