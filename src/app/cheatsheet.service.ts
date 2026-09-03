import { Injectable, inject } from '@angular/core';
import { Cheatsheet, type CheatsheetT } from '../lib/schema';
import { ApiService } from './api.service';
import { SectionService } from './section.service';

/**
 * Grammar cheat sheet of the current section, fetched on first visit to
 * /cheatsheet and cached per section. Rejections evict so a reload retries.
 */
@Injectable({ providedIn: 'root' })
export class CheatsheetService {
  private readonly api = inject(ApiService);
  private readonly section = inject(SectionService);
  private readonly cache = new Map<string, Promise<CheatsheetT>>();

  async get(): Promise<CheatsheetT> {
    const id = this.section.id();
    const cached = this.cache.get(id);
    if (cached) return cached;
    const promise = this.fetchAndValidate(id).catch((error: unknown) => {
      this.cache.delete(id);
      throw error;
    });
    this.cache.set(id, promise);
    return promise;
  }

  /** Drop the cached sheet (after a rebuild job). */
  invalidate(): void {
    this.cache.delete(this.section.id());
  }

  private async fetchAndValidate(sectionId: string): Promise<CheatsheetT> {
    const raw = await this.api.get<unknown>(`/api/sections/${encodeURIComponent(sectionId)}/cheatsheet`);
    const result = Cheatsheet.safeParse(raw);
    if (!result.success) {
      throw new Error('CheatsheetService.get(): schema validation failed', { cause: result.error });
    }
    return result.data;
  }
}
