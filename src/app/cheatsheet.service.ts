import { Injectable } from '@angular/core';
import { Cheatsheet, type CheatsheetT } from '../lib/schema';

/**
 * Lazy-loaded cheat sheet. After #19 the grammar cheat sheet ships from the
 * repo root as `/cheatsheet.json` via the angular.json assets glob — fetched
 * only when the user opens /cheatsheet, not bundled into the initial chunk.
 *
 * Rejections auto-evict from `fetched`, so resource.reload() performs a fresh
 * request and the component can expose a real error state.
 */
@Injectable({ providedIn: 'root' })
export class CheatsheetService {
  private fetched: Promise<CheatsheetT> | null = null;

  async get(): Promise<CheatsheetT> {
    if (this.fetched) return this.fetched;
    const promise = this.fetchAndValidate().catch((error: unknown) => {
      this.fetched = null;
      throw error;
    });
    this.fetched = promise;
    return promise;
  }

  private async fetchAndValidate(): Promise<CheatsheetT> {
    const res = await fetch('cheatsheet.json', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`CheatsheetService.get(): HTTP ${res.status}`);
    const raw = (await res.json()) as unknown;
    const result = Cheatsheet.safeParse(raw);
    if (!result.success) {
      throw new Error('CheatsheetService.get(): schema validation failed', {
        cause: result.error,
      });
    }
    return result.data;
  }
}
