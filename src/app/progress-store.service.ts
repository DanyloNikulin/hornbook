import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY_PROGRESS,
  type DailyStateT,
  type ProgressT,
  type QuizResultT,
  type Sm2StateT,
} from '../lib/schema';
import { ApiService } from './api.service';

const SAVE_DEBOUNCE_MS = 400;

/**
 * Learner progress for the current section, mirrored from
 * `<section>/_progress.json`. Signals are the in-memory truth; every write
 * is debounced into one PUT of the whole document (a few KB).
 *
 * Loaded by the section guard, so section pages never see another
 * section's state.
 */
@Injectable({ providedIn: 'root' })
export class ProgressStore {
  private readonly api = inject(ApiService);

  readonly sectionId = signal<string | null>(null);
  readonly sm2 = signal<Record<string, Sm2StateT>>({});
  readonly daily = signal<DailyStateT | null>(null);
  readonly quiz = signal<Record<string, QuizResultT>>({});
  readonly activity = signal<Record<string, number>>({});
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;

  async load(sectionId: string): Promise<void> {
    await this.flush();
    this.sectionId.set(sectionId);
    this.apply(EMPTY_PROGRESS);
    try {
      const p = await this.api.get<ProgressT>(`/api/sections/${encodeURIComponent(sectionId)}/progress`);
      // The section may have changed while the request was in flight.
      if (this.sectionId() !== sectionId) return;
      this.apply(p);
      this.loadError.set(null);
    } catch (err) {
      this.loadError.set((err as Error).message);
    }
  }

  private apply(p: ProgressT): void {
    this.sm2.set(p.sm2);
    this.daily.set(p.daily);
    this.quiz.set(p.quiz);
    this.activity.set(p.activity);
  }

  setSm2(map: Record<string, Sm2StateT>): void {
    this.sm2.set(map);
    this.schedule();
  }

  setDaily(d: DailyStateT | null): void {
    this.daily.set(d);
    this.schedule();
  }

  setQuiz(map: Record<string, QuizResultT>): void {
    this.quiz.set(map);
    this.schedule();
  }

  setActivity(map: Record<string, number>): void {
    this.activity.set(map);
    this.schedule();
  }

  snapshot(): ProgressT {
    return { sm2: this.sm2(), daily: this.daily(), quiz: this.quiz(), activity: this.activity() };
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Write immediately (section switch, tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.save();
    } else if (this.pending) {
      await this.pending;
    }
  }

  private save(): Promise<void> {
    const id = this.sectionId();
    if (!id) return Promise.resolve();
    const body = this.snapshot();
    this.pending = this.api
      .put(`/api/sections/${encodeURIComponent(id)}/progress`, body)
      .then(() => this.saveError.set(null))
      .catch((err: unknown) => {
        this.saveError.set((err as Error).message);
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
