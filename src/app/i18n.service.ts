import { Injectable, InjectionToken, PendingTasks, effect, inject, signal } from '@angular/core';
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  catalogFor,
  isLocale,
  isCatalogLoaded,
  loadCatalog,
  nextLocale,
  translate,
  type LocaleId,
  type Vars,
} from '../lib/i18n';
import { DesktopService } from './desktop.service';

const LOCALE_KEY = 'hornbook-locale';
export const LOCALE_LOADER = new InjectionToken<{
  load: typeof loadCatalog;
  isLoaded: typeof isCatalogLoaded;
}>('Locale loader', {
  providedIn: 'root',
  factory: () => ({ load: loadCatalog, isLoaded: isCatalogLoaded }),
});

/**
 * Chrome locale. Independent of the open pair: switching pairs must not
 * change the interface language. Persists in localStorage like day/night,
 * and in the desktop shell's preferences too: the packaged window's origin
 * is a loopback port picked at every launch, so its storage starts empty.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly initialLocale = this.savedLocale();
  private readonly pending = inject(PendingTasks);
  private readonly catalogs = inject(LOCALE_LOADER);
  private readonly desktop = inject(DesktopService);
  private selection = 0;
  private readonly committed = signal(false);
  readonly locale = signal<LocaleId>(DEFAULT_LOCALE);
  readonly loadFailed = signal(false);
  readonly meta = () => LOCALE_META[this.locale()];
  readonly nextMeta = () => LOCALE_META[nextLocale(this.locale())];

  constructor() {
    effect(() => {
      const locale = this.locale();
      document.documentElement.lang = locale;
      if (!this.committed()) return;
      try {
        localStorage.setItem(LOCALE_KEY, locale);
      } catch {
        // private mode / blocked storage: the choice just won't persist
      }
    });
  }

  t(key: string, vars?: Vars): string {
    const locale = this.locale();
    return translate(catalogFor(locale), locale, key, vars);
  }

  initialize(): Promise<void> {
    return this.desktop.initialize().then(() => this.select(this.rememberedLocale(), false));
  }

  set(locale: LocaleId): Promise<void> {
    return this.select(locale, true);
  }

  private select(locale: LocaleId, remember: boolean): Promise<void> {
    const selection = ++this.selection;
    this.loadFailed.set(false);
    if (this.catalogs.isLoaded(locale)) {
      this.commit(locale, remember);
      return Promise.resolve();
    }
    const done = this.pending.add();
    return this.catalogs
      .load(locale)
      .then(
        () => {
          if (selection === this.selection) this.commit(locale, remember);
        },
        () => {
          if (selection === this.selection) this.loadFailed.set(true);
        },
      )
      .finally(done);
  }

  cycle(): void {
    void this.set(nextLocale(this.locale()));
  }

  private commit(locale: LocaleId, remember: boolean): void {
    this.locale.set(locale);
    this.committed.set(true);
    if (remember) this.remember(locale);
  }

  /** A choice made in this window, handed to the desktop shell to keep. */
  private remember(locale: LocaleId): void {
    if (!this.desktop.available() || this.desktop.state()?.preferences.locale === locale) return;
    void this.desktop.setPreferences({ locale });
  }

  /** The desktop shell's memory wins over this origin's storage. */
  private rememberedLocale(): LocaleId {
    const remembered = this.desktop.state()?.preferences.locale;
    return remembered && isLocale(remembered) ? remembered : this.initialLocale;
  }

  private savedLocale(): LocaleId {
    let saved: string | null;
    try {
      saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_KEY) : null;
    } catch {
      saved = null;
    }
    return saved && isLocale(saved) ? saved : DEFAULT_LOCALE;
  }
}
