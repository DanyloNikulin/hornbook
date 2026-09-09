import { Injectable, effect, inject, signal } from '@angular/core';
import { DEFAULT_APPEARANCE, validAppearance, type AppearancePreferences } from '../lib/appearance';
import { DesktopService } from './desktop.service';

const STORAGE_KEY = 'hornbook-appearance';

@Injectable({ providedIn: 'root' })
export class AppearanceService {
  private readonly desktop = inject(DesktopService);
  readonly preferences = signal<AppearancePreferences>(this.saved());
  readonly saveFailed = signal(false);
  private pendingSave: Promise<void> = Promise.resolve();

  constructor() {
    effect(() => {
      const prefs = this.preferences();
      const root = document.documentElement;
      root.toggleAttribute('data-reduce-transparency', prefs.reduceTransparency);
      root.toggleAttribute('data-increase-contrast', prefs.increaseContrast);
      // Percentages preserve the browser's default text size.
      root.style.fontSize = prefs.textScale === 100 ? '' : `${prefs.textScale}%`;
    });
  }

  async initialize(): Promise<void> {
    await this.desktop.initialize();
    const remembered = this.desktop.state()?.preferences.appearance;
    if (validAppearance(remembered)) this.preferences.set(remembered);
  }

  set(patch: Partial<AppearancePreferences>): void {
    const next = { ...this.preferences(), ...patch };
    if (!validAppearance(next)) return;
    this.preferences.set(next);
    this.saveFailed.set(false);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      if (!this.desktop.available()) this.saveFailed.set(true);
    }
    if (this.desktop.available()) {
      // Serialize writes so a slower earlier response cannot win on restart.
      this.pendingSave = this.pendingSave.then(async () => {
        try {
          await this.desktop.setPreferences({ appearance: next });
          this.saveFailed.set(false);
        } catch {
          this.saveFailed.set(true);
        }
      });
    }
  }

  private saved(): AppearancePreferences {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (validAppearance(stored)) return stored;
    } catch {
      /* Unavailable storage uses the system-compatible defaults. */
    }
    return { ...DEFAULT_APPEARANCE };
  }
}
