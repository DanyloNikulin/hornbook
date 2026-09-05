import { Injectable, inject } from '@angular/core';
import type {
  ImportConflictStrategy,
  LessonImportResult,
  SectionImportResult,
  StartJob,
} from '../lib/api-types';
import type { LessonT } from '../lib/schema';
import { ApiService, fileToBase64 } from './api.service';
import { LessonsService } from './lessons.service';
import { CardsService } from './cards.service';
import { VocabService } from './vocab.service';
import { SearchService } from './search.service';
import { CheatsheetService } from './cheatsheet.service';
import { JournalService } from './journal.service';
import { JobsService } from './jobs.service';
import { ProgressStore } from './progress-store.service';

/** Mutation targets are explicit and remain fixed across file reads, jobs and cache refreshes. */
@Injectable({ providedIn: 'root' })
export class SectionMutations {
  private readonly api = inject(ApiService);
  private readonly lessons = inject(LessonsService);
  private readonly cards = inject(CardsService);
  private readonly vocab = inject(VocabService);
  private readonly search = inject(SearchService);
  private readonly sheets = inject(CheatsheetService);
  private readonly journal = inject(JournalService);
  private readonly jobs = inject(JobsService);
  private readonly progress = inject(ProgressStore);

  async invalidate(id: string): Promise<void> {
    this.cards.invalidate(id);
    this.vocab.invalidate(id);
    this.search.invalidate(id);
    this.sheets.invalidate(id);
    await this.lessons.invalidate(id);
  }
  async saveLesson(id: string, lesson: LessonT): Promise<LessonT> {
    const result = await this.api.post<LessonT>(
      `/api/sections/${encodeURIComponent(id)}/lessons`,
      lesson,
    );
    await this.invalidate(id);
    return result;
  }
  async importLesson(
    id: string,
    file: File,
    conflict: ImportConflictStrategy,
  ): Promise<LessonImportResult> {
    const lesson: unknown = JSON.parse(await file.text());
    const result = await this.api.post<LessonImportResult>(
      `/api/sections/${encodeURIComponent(id)}/lessons/import`,
      { lesson, conflict },
    );
    await this.invalidate(id);
    return result;
  }
  async importSection(file: File, conflict: ImportConflictStrategy): Promise<SectionImportResult> {
    const base64 = await fileToBase64(file);
    const result = await this.api.post<SectionImportResult>('/api/sections/import', {
      base64,
      conflict,
    });
    await Promise.all([
      this.invalidate(result.section.id),
      this.progress.externalChange(result.section.id),
      this.journal.refresh(),
    ]);
    return result;
  }
  async runJob(id: string, input: StartJob) {
    const job = await this.jobs.run(input, id);
    if (job.status === 'done') await this.invalidate(id);
    return job;
  }
}
