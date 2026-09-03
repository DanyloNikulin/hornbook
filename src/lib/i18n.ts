// Runtime chrome catalog. Pair languages (target / learner) stay out of this
// layer: they are content, not UI copy. The locale is a chrome choice the
// user toggles; it does not follow the open pair.

import { EN } from './i18n.en';
import { IT } from './i18n.it';

export const DEFAULT_LOCALE = 'en' as const;
export type LocaleId = 'en' | 'it';

export const SUPPORTED_LOCALES: readonly LocaleId[] = ['en', 'it'];

/** Autonyms shown on the switcher; not translated, so each stays recognizable. */
export const LOCALE_META: Record<LocaleId, { code: string; autonym: string }> = {
  en: { code: 'EN', autonym: 'English' },
  it: { code: 'IT', autonym: 'Italiano' },
};

export type Vars = Record<string, string | number>;

export interface Plural {
  zero?: string;
  one?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Message = string | Plural;
export type Catalog = Readonly<Record<string, Message>>;

const TOKEN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

const CATALOGS: Record<LocaleId, Catalog> = { en: EN, it: IT };

export function isLocale(value: string): value is LocaleId {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function catalogFor(locale: string): Catalog {
  return isLocale(locale) ? CATALOGS[locale] : CATALOGS[DEFAULT_LOCALE];
}

export function nextLocale(current: LocaleId): LocaleId {
  const i = SUPPORTED_LOCALES.indexOf(current);
  return SUPPORTED_LOCALES[(i + 1) % SUPPORTED_LOCALES.length];
}

export function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** English and Italian share one/other. Other locales plug in here later. */
export function pluralCategory(_locale: LocaleId, n: number): keyof Plural {
  return Math.abs(n) === 1 ? 'one' : 'other';
}

export function formatMessage(message: Message, locale: LocaleId, vars?: Vars): string {
  if (typeof message === 'string') return interpolate(message, vars);
  const n = Number(vars?.['n'] ?? 0);
  const cat = pluralCategory(locale, Number.isFinite(n) ? n : 0);
  return interpolate(message[cat] ?? message.other, vars);
}

export function translate(catalog: Catalog, locale: LocaleId, key: string, vars?: Vars): string {
  const message = catalog[key] ?? (locale === DEFAULT_LOCALE ? undefined : CATALOGS[DEFAULT_LOCALE][key]);
  if (message === undefined) return key;
  return formatMessage(message, locale, vars);
}

export function t(key: string, vars?: Vars, locale: LocaleId = DEFAULT_LOCALE): string {
  return translate(catalogFor(locale), locale, key, vars);
}

/** Demo journal tagline. Chrome localizes this; a custom brand tagline is shown as-is. */
export const STOCK_TAGLINE = 'conspects from your lessons';

export function isStockTagline(value: string): boolean {
  return value.trim().toLowerCase() === STOCK_TAGLINE;
}
