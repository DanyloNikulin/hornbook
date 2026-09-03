import { Injectable, inject } from '@angular/core';
import Fuse from 'fuse.js';
import { ApiService } from './api.service';
import { SectionService } from './section.service';

export type SearchSection = 'article' | 'vocab' | 'grammar' | 'quote' | 'slide';

export interface SearchDoc {
  lesson_slug: string;
  lesson_title: string;
  lesson_date: string;
  section: SearchSection;
  text: string;
  ts?: string;
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
  snippet: string;
}

const SNIPPET_LEN = 160;

/**
 * Full-text search over the current section. The first call fetches the
 * pre-baked document list from the API, builds one Fuse index, and caches it
 * per section. Rejections evict the entry so a retry fetches again.
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly api = inject(ApiService);
  private readonly section = inject(SectionService);
  private readonly cache = new Map<string, Promise<Fuse<SearchDoc>>>();

  async search(query: string, max = 40): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const fuse = await this.ensureReady();
    return fuse.search(q, { limit: max }).map((r) => ({
      doc: r.item,
      score: r.score ?? 1,
      snippet: this.snippet(r.item.text, q),
    }));
  }

  /** Drop the cached index (after a lesson was saved). */
  invalidate(): void {
    this.cache.delete(this.section.id());
  }

  private async ensureReady(): Promise<Fuse<SearchDoc>> {
    const id = this.section.id();
    const cached = this.cache.get(id);
    if (cached) return cached;
    const promise = this.buildIndex(id).catch((error: unknown) => {
      this.cache.delete(id);
      throw error;
    });
    this.cache.set(id, promise);
    return promise;
  }

  private async buildIndex(sectionId: string): Promise<Fuse<SearchDoc>> {
    const raw = await this.api.get<unknown>(`/api/sections/${encodeURIComponent(sectionId)}/search-index`);
    if (!Array.isArray(raw)) throw new Error('SearchService: payload is not an array');
    // The producer (scripts/lib/derived.ts) is type-checked against the same
    // SearchDoc shape, so no runtime validation per doc.
    return new Fuse(raw as SearchDoc[], {
      keys: ['text'],
      threshold: 0.35,
      ignoreLocation: true,
      includeScore: true,
      minMatchCharLength: 2,
    });
  }

  private snippet(text: string, query: string): string {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx === -1) {
      return text.length > SNIPPET_LEN ? text.slice(0, SNIPPET_LEN) + '…' : text;
    }
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + SNIPPET_LEN - 40);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
  }
}
