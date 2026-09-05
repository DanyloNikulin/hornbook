import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ProvidersT } from '../../lib/journal-config';
import { LOCALE_META, SUPPORTED_LOCALES, type LocaleId } from '../../lib/i18n';
import { CONNECTION_KEYS, type ConnectionKey, type SettingsView } from '../../lib/api-types';
import { TPipe } from '../i18n.pipe';
import { I18nService } from '../i18n.service';
import { ApiService } from '../api.service';
import { SectionService } from '../section.service';
import { JournalService } from '../journal.service';
import { SettingsNavComponent } from './settings-nav.component';
import { PipelineSetupComponent } from './pipeline-setup.component';
import { LocalSetupComponent } from './local-setup.component';
import { DesktopService } from '../desktop.service';
import { UpdateService } from '../update.service';

/**
 * Journal-wide settings: interface language, default models, connection keys.
 * Reachable from home as /settings and from a pair as /:section/application.
 */
@Component({
  selector: 'app-app-settings',
  imports: [FormsModule, RouterLink, TPipe, SettingsNavComponent, PipelineSetupComponent, LocalSetupComponent],
  templateUrl: './app-settings.component.html',
})
export class AppSettingsComponent {
  protected readonly sec = inject(SectionService);
  private readonly api = inject(ApiService);
  private readonly journal = inject(JournalService);
  private readonly destroyRef = inject(DestroyRef);
  private saveRevision = 0;
  private readonly i18n = inject(I18nService);
  private readonly route = inject(ActivatedRoute);
  protected readonly desktop = inject(DesktopService);
  protected readonly updates = inject(UpdateService);

  protected readonly locales = SUPPORTED_LOCALES;
  protected readonly localeMeta = LOCALE_META;
  protected readonly locale = this.i18n.locale;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal<string | null>(null);
  protected readonly advanced = signal(false);
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

  protected async chooseJournal(): Promise<void> {
    await this.desktop.chooseJournal();
  }

  protected async openJournal(): Promise<void> {
    await this.desktop.openJournal();
  }

  protected async chooseFfmpeg(): Promise<void> {
    const path = await this.desktop.chooseToolPath('FFMPEG_BIN');
    if (path) this.connectionInput['FFMPEG_BIN'] = path;
  }

  protected async setStartWithSystem(value: boolean): Promise<void> {
    await this.desktop.setPreferences({ startWithSystem: value });
  }

  protected async setAutomaticUpdates(value: boolean): Promise<void> {
    await this.updates.setAutomatic(value);
  }

  protected checkUpdates(): void {
    void this.updates.check(true);
  }

  protected localActivated(settings: SettingsView): void {
    this.saveRevision++;
    this.settings.set(settings);
    this.defaults = structuredClone(settings.providers);
    this.saved.set(this.i18n.t('settings.saved'));
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
    const revision = ++this.saveRevision;
    this.saving.set(true);
    this.error.set(null);
    this.saved.set(null);
    try {
      const connections: Partial<Record<ConnectionKey, string | null>> = {};
      for (const key of CONNECTION_KEYS) {
        if (this.clearConnection[key]) connections[key] = null;
        else if (this.connectionInput[key].trim()) connections[key] = this.connectionInput[key].trim();
      }
      const s = await this.journal.saveSettings({ providers: structuredClone(this.defaults), connections });
      if (!s || this.destroyRef.destroyed || revision !== this.saveRevision) return;
      this.settings.set(s);
      this.defaults = structuredClone(s.providers);
      for (const key of CONNECTION_KEYS) {
        this.connectionInput[key] = '';
        this.clearConnection[key] = false;
      }
      this.saved.set(this.i18n.t('settings.saved'));
    } catch (err) {
      if (!this.destroyRef.destroyed && revision === this.saveRevision) this.error.set((err as Error).message);
    } finally {
      this.saving.set(false);
    }
  }
}
