import { Injectable, inject, signal } from '@angular/core';
import { z } from 'zod';
import { ProgressService } from './progress.service';
import { idbGet, idbSet, migrateFromLocalStorage } from '../lib/storage';

export interface QuizResult {
  best_score: number;
  total: number;
  attempts: number;
  last_at: string;
}

const STORAGE_KEY = 'quiz-results';
type ResultsMap = Record<string, QuizResult>;

const QuizResultSchema: z.ZodType<QuizResult> = z.object({
  best_score: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  last_at: z.string().min(1),
});
const ResultsMapSchema = z.record(z.string(), QuizResultSchema);

@Injectable({ providedIn: 'root' })
export class QuizResultsService {
  private readonly progress = inject(ProgressService);
  // Empty default replaced by the async loader below; computed signals in
  // consumers (e.g. lesson-list quiz badges) re-render once data arrives.
  private readonly results = signal<ResultsMap>({});

  // Resolves after the initial load + one-time localStorage migration. Tests
  // await this; production code rarely needs to.
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const migrated = await migrateFromLocalStorage<unknown>(STORAGE_KEY);
    const raw = migrated !== undefined ? migrated : await idbGet<unknown>(STORAGE_KEY);
    if (raw === undefined) return;
    const parsed = ResultsMapSchema.safeParse(raw);
    if (parsed.success) this.results.set(parsed.data);
  }

  forLesson(slug: string): QuizResult | null {
    return this.results()[slug] ?? null;
  }

  record(slug: string, score: number, total: number): QuizResult {
    const map = { ...this.results() };
    const prev = map[slug];
    const best = Math.max(prev?.best_score ?? 0, score);
    const next: QuizResult = {
      best_score: best,
      total,
      attempts: (prev?.attempts ?? 0) + 1,
      last_at: new Date().toISOString(),
    };
    map[slug] = next;
    this.results.set(map);
    void idbSet(STORAGE_KEY, map);
    this.progress.record(total); // count quiz submission as N activities
    return next;
  }
}
