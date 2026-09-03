import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ProvidersT, SectionThemeT } from '../../lib/journal-config';
import { DEFAULT_PRESET_ID, DISPLAY_FONTS, THEME_PRESETS, type ThemePreset } from '../../lib/themes';
import { type JobView, type SectionSummary, type SettingsView } from '../../lib/api-types';
import { TPipe } from '../i18n.pipe';
import { I18nService } from '../i18n.service';
import { ApiService } from '../api.service';
import { JournalService } from '../journal.service';
import { SectionService } from '../section.service';
import { JobsService } from '../jobs.service';
import { ThemeService } from '../theme.service';
import { SettingsNavComponent } from './settings-nav.component';
import { PipelineSetupComponent } from './pipeline-setup.component';

type Field = 'transcribe' | 'extract';

/**
 * Settings that belong to the open pair: look, model overrides, topic review.
 * Journal defaults and keys live on the application settings page.
 */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, TPipe, SettingsNavComponent, PipelineSetupComponent],
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  protected readonly sec = inject(SectionService);
  private readonly api = inject(ApiService);
  private readonly journal = inject(JournalService);
  private readonly jobs = inject(JobsService);
  private readonly theme = inject(ThemeService);

  protected readonly presets = THEME_PRESETS;
  protected readonly displayFonts = DISPLAY_FONTS;
  private readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal<string | null>(null);

  // Journal defaults (read-only here; edited on the application page).
  protected defaults: ProvidersT = {
    transcribe: { driver: 'whisper-cli', model: 'base' },
    extract: { driver: 'ollama', model: 'llama3.1' },
  };
  protected override: Record<Field, boolean> = { transcribe: false, extract: false };
  protected overrides: ProvidersT = {
    transcribe: { driver: 'whisper-cli', model: 'base' },
    extract: { driver: 'ollama', model: 'llama3.1' },
  };

  // ---- look ----
  protected readonly preset = signal<string>(DEFAULT_PRESET_ID);
  protected readonly displayFont = signal<string>('');
  protected readonly backdrop = signal<string | undefined>(undefined);
  protected readonly backdropBusy = signal(false);
  /** Cache-busting suffix so a replaced image is re-fetched. */
  protected readonly backdropStamp = signal(Date.now());

  protected readonly job = computed(() => this.jobs.current());
  protected readonly jobRunning = computed(() => {
    const j = this.job();
    return j?.status === 'queued' || j?.status === 'running';
  });

  constructor() {
    const t = this.sec.theme();
    this.preset.set(t?.preset ?? DEFAULT_PRESET_ID);
    this.displayFont.set(t?.display_font ?? '');
    this.backdrop.set(t?.backdrop);
    void this.load();
  }

  protected backdropUrl(): string {
    return `${this.sec.apiBase()}/backdrop?v=${this.backdropStamp()}`;
  }

  /** Paint a preset without saving, so the choice is visible immediately. */
  protected previewPreset(p: ThemePreset): void {
    this.preset.set(p.id);
    this.theme.preview(this.draftTheme());
  }

  protected previewFont(id: string): void {
    this.displayFont.set(id);
    this.theme.preview(this.draftTheme());
  }

  private draftTheme(): SectionThemeT & { backdropUrl?: string } {
    const theme: SectionThemeT = {};
    if (this.preset() !== DEFAULT_PRESET_ID) theme.preset = this.preset();
    if (this.displayFont()) theme.display_font = this.displayFont();
    if (this.backdrop()) theme.backdrop = this.backdrop();
    return { ...theme, backdropUrl: this.backdrop() ? this.backdropUrl() : undefined };
  }

  /** Theme to persist: null when everything is at its default. */
  private themeToSave(): SectionThemeT | null {
    const theme = { ...this.draftTheme() };
    delete theme.backdropUrl;
    return Object.keys(theme).length > 0 ? theme : null;
  }

  protected async uploadBackdrop(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.backdropBusy.set(true);
    this.error.set(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const updated = await this.api.put<SectionSummary>(`${this.sec.apiBase()}/backdrop`, {
        filename: file.name,
        base64,
      });
      this.sec.set(updated);
      this.backdrop.set(updated.theme?.backdrop);
      this.backdropStamp.set(Date.now());
      this.theme.preview(this.draftTheme());
      await this.journal.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.backdropBusy.set(false);
      input.value = '';
    }
  }

  protected async removeBackdrop(): Promise<void> {
    this.backdropBusy.set(true);
    this.error.set(null);
    try {
      const updated = await this.api.delete<SectionSummary>(`${this.sec.apiBase()}/backdrop`);
      this.sec.set(updated);
      this.backdrop.set(undefined);
      this.theme.preview(this.draftTheme());
      await this.journal.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.backdropBusy.set(false);
    }
  }

  protected effective(field: Field): { driver: string; model: string } {
    return this.override[field] ? this.overrides[field] : this.defaults[field];
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const s = await this.api.get<SettingsView>('/api/settings');
      this.defaults = structuredClone(s.providers);
      const current = this.sec.current();
      const p = current?.providers;
      for (const field of ['transcribe', 'extract'] as const) {
        const o = p?.[field];
        this.override[field] = !!o;
        this.overrides[field] = o ? { ...o } : { ...s.providers[field] };
      }
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
      const sectionProviders: Partial<ProvidersT> = {};
      if (this.override.transcribe) sectionProviders.transcribe = { ...this.overrides.transcribe };
      if (this.override.extract) sectionProviders.extract = { ...this.overrides.extract };
      const hasOverride = Object.keys(sectionProviders).length > 0;
      const updated = await this.api.patch<SectionSummary>(this.sec.apiBase(), {
        providers: hasOverride ? sectionProviders : null,
        theme: this.themeToSave(),
      });
      this.sec.set(updated);
      this.theme.restore();
      await this.journal.refresh();
      this.saved.set(this.i18n.t('settings.saved'));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  protected async reviewTopics(): Promise<void> {
    this.error.set(null);
    try {
      const job: JobView = await this.jobs.run({ kind: 'review-topics' });
      if (job.status !== 'done') this.error.set(job.error ?? this.i18n.t('settings.reviewFailed'));
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
