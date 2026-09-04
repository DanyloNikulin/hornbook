import { Injectable, computed, signal } from '@angular/core';
import type { ConnectionKey, DesktopPreferencesView, DesktopState, DesktopUpdateState } from '../lib/api-types';
import type { DesktopToolPath } from '../lib/desktop';

@Injectable({ providedIn: 'root' })
export class DesktopService {
  readonly state = signal<DesktopState | null>(null);
  readonly available = computed(() => this.state() !== null);
  readonly update = signal<DesktopUpdateState | null>(null);
  private inflight: Promise<void> | null = null;
  private listening = false;

  initialize(): Promise<void> {
    if (this.inflight) return this.inflight;
    const bridge = globalThis.window?.hornbookDesktop;
    if (!bridge) return Promise.resolve();
    this.inflight = bridge
      .state()
      .then((state) => {
        this.state.set(state);
        this.update.set(state.update);
        if (!this.listening) {
          this.listening = true;
          bridge.onUpdate((update) => {
            this.update.set(update);
            this.state.update((current) => (current ? { ...current, update } : current));
          });
        }
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async chooseJournal(): Promise<boolean> {
    return (await globalThis.window?.hornbookDesktop?.chooseJournal()) ?? false;
  }

  async openJournal(): Promise<void> {
    await globalThis.window?.hornbookDesktop?.openJournal();
  }

  async chooseToolPath(kind: Extract<ConnectionKey, DesktopToolPath>): Promise<string | null> {
    return (await globalThis.window?.hornbookDesktop?.chooseToolPath(kind)) ?? null;
  }

  async setPreferences(patch: Partial<DesktopPreferencesView>): Promise<void> {
    const next = await globalThis.window?.hornbookDesktop?.setPreferences(patch);
    if (next) {
      this.state.set(next);
      this.update.set(next.update);
    }
  }
}
