import { Injectable } from '@angular/core';
import { DerivedVocab, type DerivedVocabT } from '../lib/schema';

/**
 * Lazy-loaded global vocabulary. After #19 the dedup'd vocab list ships as a
 * static asset at `/lessons/_vocab.json` rather than being bundled into the
 * initial JS chunk — at ~200 entries it's already big enough to dominate the
 * vocab page's chunk, and it scales linearly with lesson count.
 *
 * One in-flight fetch is shared across concurrent callers via the `fetched`
 * promise (idempotent per service instance). HTTP-layer caching (CF Pages
 * `Cache-Control: max-age=3600`) handles cross-session caching. Rejections
 * auto-evict from `fetched`, so a resource reload performs a fresh request.
 */
@Injectable({ providedIn: 'root' })
export class VocabService {
  private fetched: Promise<readonly DerivedVocabT[]> | null = null;

  async all(): Promise<readonly DerivedVocabT[]> {
    if (this.fetched) return this.fetched;
    const promise = this.fetchAndValidate().catch((error: unknown) => {
      this.fetched = null;
      throw error;
    });
    this.fetched = promise;
    return promise;
  }

  // Deterministic by date — every visitor sees the same word on the same day,
  // and refreshing doesn't change it. FNV-1a-ish hash of the date string.
  // Returns null on first call before the fetch completes; the flashcards
  // dashboard renders the word once `await this.vocab.wordOfDay(today())`
  // resolves. Callers in templates should use a signal-from-promise pattern.
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

  private async fetchAndValidate(): Promise<readonly DerivedVocabT[]> {
    const res = await fetch('lessons/_vocab.json', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`VocabService.all(): HTTP ${res.status}`);
    }
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) throw new Error('VocabService.all(): payload is not an array');
    return raw.map((entry, idx) => {
      const parsed = DerivedVocab.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`VocabService.all(): invalid entry at index ${idx}`, {
          cause: parsed.error,
        });
      }
      return parsed.data;
    });
  }
}
