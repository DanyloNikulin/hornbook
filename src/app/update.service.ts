import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { DesktopUpdateState, ModeView, ReleaseCheckView } from '../lib/api-types';
import { ApiService } from './api.service';
import { DesktopService } from './desktop.service';

const AUTOMATIC_KEY = 'hornbook-automatic-updates';
const CHECKED_KEY = 'hornbook-update-checked-at';
const DISMISSED_KEY = 'hornbook-update-dismissed';
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly api = inject(ApiService);
  readonly desktop = inject(DesktopService);
  readonly state = signal<DesktopUpdateState>({ phase: 'idle', currentVersion: '', installable: false });
  readonly automatic = signal(this.saved(AUTOMATIC_KEY) !== 'false');
  private readonly dismissed = signal(this.saved(DISMISSED_KEY));

  constructor() {
    effect(() => {
      const state = this.desktop.update();
      if (state) this.state.set(state);
    });
  }

  readonly banner = computed(() => {
    const state = this.state();
    if (!state.release || this.dismissed() === state.release.version) return null;
    return ['available', 'downloading', 'ready', 'error'].includes(state.phase) ? state : null;
  });

  async initialize(): Promise<void> {
    await this.desktop.initialize();
    const desktopState = this.desktop.state();
    if (desktopState) {
      this.automatic.set(desktopState.preferences.automaticUpdates);
      this.state.set(desktopState.update);
      return;
    }
    void this.loadCurrentVersion();
    const checked = Date.parse(this.saved(CHECKED_KEY) ?? '');
    if (this.automatic() && (!Number.isFinite(checked) || Date.now() - checked >= DAY_MS)) void this.check(false);
  }

  async check(force = true): Promise<void> {
    if (this.desktop.available()) {
      const state = await globalThis.window?.hornbookDesktop?.checkForUpdates(force);
      if (state) this.state.set(state);
      return;
    }
    this.state.update((state) => ({ ...state, phase: 'checking' }));
    try {
      const result = await this.api.get<ReleaseCheckView>(`/api/update${force ? '?force=1' : ''}`);
      localStorage.setItem(CHECKED_KEY, result.checkedAt);
      this.state.set({
        phase: result.error ? 'error' : result.available ? 'available' : 'current',
        currentVersion: result.currentVersion,
        installable: false,
        checkedAt: result.checkedAt,
        release: result.available ? result.release : undefined,
        error: result.error,
      });
    } catch (error) {
      localStorage.setItem(CHECKED_KEY, new Date().toISOString());
      this.state.update((state) => ({ ...state, phase: 'error', error: (error as Error).message }));
    }
  }

  async setAutomatic(value: boolean): Promise<void> {
    this.automatic.set(value);
    localStorage.setItem(AUTOMATIC_KEY, String(value));
    if (this.desktop.available()) await this.desktop.setPreferences({ automaticUpdates: value });
    if (value && this.state().phase === 'idle') await this.check(false);
  }

  dismiss(): void {
    const version = this.state().release?.version;
    if (!version) return;
    this.dismissed.set(version);
    localStorage.setItem(DISMISSED_KEY, version);
  }

  async restart(): Promise<void> {
    await globalThis.window?.hornbookDesktop?.restartToUpdate();
  }

  displayVersion(version: string): string {
    return version.endsWith('.0') ? version.slice(0, -2) : version;
  }

  private async loadCurrentVersion(): Promise<void> {
    try {
      const mode = await this.api.get<ModeView>('/api/mode');
      this.state.update((state) =>
        state.currentVersion ? state : { ...state, currentVersion: mode.version },
      );
    } catch {
      // The rest of the application reports server connectivity failures.
    }
  }

  private saved(key: string): string | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    } catch {
      return null;
    }
  }
}
