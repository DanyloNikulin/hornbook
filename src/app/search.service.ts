import { Injectable } from '@angular/core';
import Fuse from 'fuse.js';

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
 * Lazy-loaded full-text search. After #19 the Fuse index is built from a
 * pre-baked document list at `/lessons/_search-index.json` (emitted by
 * scripts/build-derived.ts). The first call to `search()` fetches the index,
 * constructs Fuse once, and caches both for the rest of the session.
 *
 * Concurrent calls share the same in-flight initialization via the `ready`
 * promise — no double-fetch even if the user mashes Enter. Rejections
 * auto-evict from `ready`, so a retry triggers a fresh fetch.
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private ready: Promise<Fuse<SearchDoc>> | null = null;

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

  private async ensureReady(): Promise<Fuse<SearchDoc>> {
    if (this.ready) return this.ready;
    const promise = this.buildIndex().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    this.ready = promise;
    return promise;
  }

  private async buildIndex(): Promise<Fuse<SearchDoc>> {
    const res = await fetch('lessons/_search-index.json', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`SearchService: HTTP ${res.status}`);
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) throw new Error('SearchService: payload is not an array');
    // The producer (build-derived.ts) is type-checked against the same
    // SearchDoc shape, so no runtime validation per doc — trusting the
    // build step here keeps the lazy-load fast.
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
