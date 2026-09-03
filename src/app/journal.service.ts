import { Injectable, computed, inject, signal } from '@angular/core';
import type { ConfigView, SectionSummary } from '../lib/api-types';
import { STOCK_TAGLINE } from '../lib/i18n';
import { ApiService } from './api.service';

const PLACEHOLDER: ConfigView = {
  brand: { name: 'Hornbook', tagline: STOCK_TAGLINE },
  providers: {
    transcribe: { driver: 'whisper-cli', model: 'base' },
    extract: { driver: 'ollama', model: 'llama3.1' },
  },
  sections: [],
};

/**
 * Journal-level configuration (brand, providers, the list of sections),
 * loaded once from the API at startup and refreshed after a section is
 * created or changed.
 */
@Injectable({ providedIn: 'root' })
export class JournalService {
  private readonly api = inject(ApiService);

  readonly config = signal<ConfigView>(PLACEHOLDER);
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly sections = computed(() => this.config().sections);

  private inflight: Promise<void> | null = null;

  /** Fetch the config; concurrent callers share one request. */
  load(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.api
      .get<ConfigView>('/api/config')
      .then((c) => {
        this.config.set(c);
        this.loaded.set(true);
        this.loadError.set(null);
      })
      .catch((err: unknown) => {
        this.loadError.set((err as Error).message);
        this.loaded.set(true);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded()) await this.load();
  }

  /** Re-fetch after a write (new section, renamed section). */
  async refresh(): Promise<void> {
    this.loaded.set(false);
    await this.load();
  }

  section(id: string): SectionSummary | undefined {
    return this.sections().find((s) => s.id === id);
  }

  brandName(): string {
    return this.config().brand.name;
  }

  tagline(): string {
    return this.config().brand.tagline;
  }
}
