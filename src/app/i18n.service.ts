import { Injectable, effect, signal } from '@angular/core';
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  catalogFor,
  isLocale,
  nextLocale,
  translate,
  type LocaleId,
  type Vars,
} from '../lib/i18n';

const LOCALE_KEY = 'hornbook-locale';

/**
 * Chrome locale. Independent of the open pair: switching pairs must not
 * change the interface language. Persists in localStorage like day/night.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly locale = signal<LocaleId>(this.savedLocale());
  readonly meta = () => LOCALE_META[this.locale()];
  readonly nextMeta = () => LOCALE_META[nextLocale(this.locale())];

  constructor() {
    effect(() => {
      const locale = this.locale();
      document.documentElement.lang = locale;
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

  set(locale: LocaleId): void {
    this.locale.set(locale);
  }

  cycle(): void {
    this.locale.set(nextLocale(this.locale()));
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
