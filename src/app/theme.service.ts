import { Injectable, effect, inject, signal } from '@angular/core';
import {
  THEME_VARIABLE_NAMES,
  themeVariables,
  type AppliedTheme,
  type ThemeMode,
} from '../lib/themes';
import { SectionService } from './section.service';

const THEME_KEY = 'hornbook-theme';

/**
 * Owns the day/night choice and paints the current section's look on top of
 * it. Both are CSS variables on the root element, so every existing rule
 * keeps working: a preset only changes what `--primary` and friends resolve
 * to. Outside a section the variables are cleared and the stylesheet
 * defaults apply.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly section = inject(SectionService);

  readonly mode = signal<ThemeMode>(this.savedMode());

  /**
   * A look being tried out in Settings, with the section it belongs to. It
   * survives a day/night toggle — checking both modes is the point of a
   * preview — but never leaks into another section.
   */
  private readonly previewed = signal<{ section: string; theme: AppliedTheme } | null>(null);

  constructor() {
    effect(() => {
      const mode = this.mode();
      document.documentElement.setAttribute('data-theme', mode);
      try {
        localStorage.setItem(THEME_KEY, mode);
      } catch {
        // private mode / blocked storage: the choice just won't persist
      }
    });

    effect(() => {
      const section = this.section.current();
      const mode = this.mode();
      const preview = this.previewed();
      const stored = section ? this.themeFor(section.id, section.theme) : undefined;
      this.apply(preview && preview.section === section?.id ? preview.theme : stored, mode);
    });
  }

  toggle(): void {
    this.mode.update((m) => (m === 'night' ? 'day' : 'night'));
  }

  /** Paint a look without saving it — used by the picker for a live preview. */
  preview(theme: AppliedTheme): void {
    const id = this.section.id();
    if (id) this.previewed.set({ section: id, theme });
  }

  /** Drop any preview and return to the current section's stored look. */
  restore(): void {
    this.previewed.set(null);
  }

  /** Section theme plus the URL its backdrop image would be served from. */
  themeFor(sectionId: string, theme: AppliedTheme | undefined): AppliedTheme {
    return {
      ...theme,
      backdropUrl: theme?.backdrop ? `/api/sections/${encodeURIComponent(sectionId)}/backdrop` : undefined,
    };
  }

  private apply(theme: AppliedTheme | undefined, mode: ThemeMode): void {
    const root = document.documentElement;
    if (!theme) {
      for (const name of THEME_VARIABLE_NAMES) root.style.removeProperty(name);
      return;
    }
    const vars = themeVariables(theme, mode);
    for (const name of THEME_VARIABLE_NAMES) {
      const value = vars[name];
      if (value === undefined) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
  }

  private savedMode(): ThemeMode {
    let saved: string | null;
    try {
      saved = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    } catch {
      // blocked storage: fall back to the system preference
      saved = null;
    }
    if (saved === 'night' || saved === 'day') return saved;
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'night'
      : 'day';
  }
}
