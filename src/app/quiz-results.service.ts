import { Injectable, inject } from '@angular/core';
import type { QuizResultT } from '../lib/schema';
import { ProgressService } from './progress.service';
import { ProgressStore } from './progress-store.service';

export type QuizResult = QuizResultT;

/** Best quiz score per lesson for the current section, backed by ProgressStore. */
@Injectable({ providedIn: 'root' })
export class QuizResultsService {
  private readonly store = inject(ProgressStore);
  private readonly progress = inject(ProgressService);

  forLesson(slug: string): QuizResult | null {
    return this.store.quiz()[slug] ?? null;
  }

  record(slug: string, score: number, total: number): QuizResult {
    const map = { ...this.store.quiz() };
    const prev = map[slug];
    const next: QuizResult = {
      best_score: Math.max(prev?.best_score ?? 0, score),
      total,
      attempts: (prev?.attempts ?? 0) + 1,
      last_at: new Date().toISOString(),
    };
    map[slug] = next;
    this.store.setQuiz(map);
    this.progress.record(total); // count quiz submission as N activities
    return next;
  }
}
