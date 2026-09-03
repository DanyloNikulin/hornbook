import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ProvidersT } from '../../lib/journal-config';
import { LOCALE_META, SUPPORTED_LOCALES, type LocaleId } from '../../lib/i18n';
import { CONNECTION_KEYS, type ConnectionKey, type SettingsView } from '../../lib/api-types';
import { TPipe } from '../i18n.pipe';
import { I18nService } from '../i18n.service';
import { ApiService } from '../api.service';
import { SectionService } from '../section.service';
import { SettingsNavComponent } from './settings-nav.component';
import { PipelineSetupComponent } from './pipeline-setup.component';

/**
 * Journal-wide settings: interface language, default models, connection keys.
 * Reachable from home as /settings and from a pair as /:section/application.
 */
@Component({
  selector: 'app-app-settings',
  imports: [FormsModule, RouterLink, TPipe, SettingsNavComponent, PipelineSetupComponent],
  templateUrl: './app-settings.component.html',
})
export class AppSettingsComponent {
  protected readonly sec = inject(SectionService);
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly route = inject(ActivatedRoute);

  protected readonly locales = SUPPORTED_LOCALES;
  protected readonly localeMeta = LOCALE_META;
  protected readonly locale = this.i18n.locale;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal<string | null>(null);
  protected readonly settings = signal<SettingsView | null>(null);

  protected defaults: ProvidersT = {
    transcribe: { driver: 'whisper-cli', model: 'base' },
    extract: { driver: 'ollama', model: 'llama3.1' },
  };
  protected connectionInput: Record<ConnectionKey, string> = Object.fromEntries(
    CONNECTION_KEYS.map((k) => [k, '']),
  ) as Record<ConnectionKey, string>;
  protected clearConnection: Record<ConnectionKey, boolean> = Object.fromEntries(
    CONNECTION_KEYS.map((k) => [k, false]),
  ) as Record<ConnectionKey, boolean>;

  protected readonly backHome = computed(() => (this.sec.id() ? this.sec.home() : ['/']));
  protected readonly backLabel = computed(() => (this.sec.id() ? 'common.backToLessons' : 'setup.back'));

  constructor() {
    if (!this.route.snapshot.paramMap.get('section')) this.sec.set(null);
    void this.load();
  }

  protected setLocale(id: LocaleId): void {
    this.i18n.set(id);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const s = await this.api.get<SettingsView>('/api/settings');
      this.settings.set(s);
      this.defaults = structuredClone(s.providers);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.saved.set(null);
    try {
      const connections: Partial<Record<ConnectionKey, string | null>> = {};
      for (const key of CONNECTION_KEYS) {
        if (this.clearConnection[key]) connections[key] = null;
        else if (this.connectionInput[key].trim()) connections[key] = this.connectionInput[key].trim();
      }
      const s = await this.api.put<SettingsView>('/api/settings', { providers: this.defaults, connections });
      this.settings.set(s);
      for (const key of CONNECTION_KEYS) {
        this.connectionInput[key] = '';
        this.clearConnection[key] = false;
      }
      this.saved.set(this.i18n.t('settings.saved'));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.saving.set(false);
    }
  }
}
