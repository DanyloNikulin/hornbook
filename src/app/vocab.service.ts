import { Injectable, inject, signal } from '@angular/core';
import { DerivedVocab, type DerivedVocabT } from '../lib/schema';
import { ApiService } from './api.service';
import { SectionService } from './section.service';

/**
 * Deduplicated vocabulary of the current section, fetched from the API on
 * first use and cached per section for the session. Rejections evict the
 * cache entry so a retry performs a fresh request.
 */
@Injectable({ providedIn: 'root' })
export class VocabService {
  private readonly api = inject(ApiService);
  readonly revision = signal(0);
  private readonly section = inject(SectionService);
  private readonly cache = new Map<string, Promise<readonly DerivedVocabT[]>>();

  async all(): Promise<readonly DerivedVocabT[]> {
    const id = this.section.id();
    const cached = this.cache.get(id);
    if (cached) return cached;
    const promise = this.fetchAndValidate(id).catch((error: unknown) => {
      if (this.cache.get(id) === promise) this.cache.delete(id);
      throw error;
    });
    this.cache.set(id, promise);
    return promise;
  }

  /** Drop the cached list (after a lesson was saved). */
  invalidate(id = this.section.id()): void {
    if (id === this.section.id()) this.revision.update((value) => value + 1);
    this.cache.delete(id);
  }

  // Deterministic by date — every visitor sees the same word on the same day.
  async wordOfDay(date: string): Promise<DerivedVocabT | null> {
    const vocab = await this.all();
    if (vocab.length === 0) return null;
    let h = 0x811c9dc5;
    for (let i = 0; i < date.length; i++) {
      h ^= date.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return vocab[Math.abs(h >>> 0) % vocab.length];
  }

  private async fetchAndValidate(sectionId: string): Promise<readonly DerivedVocabT[]> {
    const raw = await this.api.get<unknown>(`/api/sections/${encodeURIComponent(sectionId)}/vocab`);
    if (!Array.isArray(raw)) throw new Error('VocabService.all(): payload is not an array');
    return raw.map((entry, idx) => {
      const parsed = DerivedVocab.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`VocabService.all(): invalid entry at index ${idx}`, { cause: parsed.error });
      }
      return parsed.data;
    });
  }
}
