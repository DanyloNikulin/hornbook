// Runtime chrome catalog. Pair languages (target / learner) stay out of this
// layer: they are content, not UI copy. The locale is a chrome choice the
// user toggles; it does not follow the open pair.

import { EN } from './i18n.en.js';
import { IT } from './i18n.it.js';

export const DEFAULT_LOCALE = 'en' as const;
export type LocaleId = 'en' | 'it' | 'es' | 'fr' | 'de' | 'pt' | 'nl' | 'sv' | 'uk';

export const SUPPORTED_LOCALES: readonly LocaleId[] = [
  'en',
  'it',
  'es',
  'fr',
  'de',
  'pt',
  'nl',
  'sv',
  'uk',
];

/** Autonyms shown on the switcher; not translated, so each stays recognizable. */
export const LOCALE_META: Record<LocaleId, { code: string; autonym: string }> = {
  en: { code: 'EN', autonym: 'English' },
  it: { code: 'IT', autonym: 'Italiano' },
  es: { code: 'ES', autonym: 'Español' },
  fr: { code: 'FR', autonym: 'Français' },
  de: { code: 'DE', autonym: 'Deutsch' },
  pt: { code: 'PT', autonym: 'Português (Portugal)' },
  nl: { code: 'NL', autonym: 'Nederlands' },
  sv: { code: 'SV', autonym: 'Svenska' },
  uk: { code: 'UK', autonym: 'Українська' },
};

export type Vars = Record<string, string | number>;

export interface Plural {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Message = string | Plural;
export type Catalog = Readonly<Record<string, Message>>;

const TOKEN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

const CATALOGS: Partial<Record<LocaleId, Catalog>> = {
  en: EN,
  it: IT,
};

const LOADERS = {
  es: () => import('./i18n.es.js').then((module) => module.ES),
  fr: () => import('./i18n.fr.js').then((module) => module.FR),
  de: () => import('./i18n.de.js').then((module) => module.DE),
  pt: () => import('./i18n.pt.js').then((module) => module.PT),
  nl: () => import('./i18n.nl.js').then((module) => module.NL),
  sv: () => import('./i18n.sv.js').then((module) => module.SV),
  uk: () => import('./i18n.uk.js').then((module) => module.UK),
};
const LOADING = new Map<LocaleId, Promise<Catalog>>();

export function isCatalogLoaded(locale: LocaleId): boolean {
  return CATALOGS[locale] !== undefined;
}

export async function loadCatalog(locale: LocaleId): Promise<Catalog> {
  const cached = CATALOGS[locale];
  if (cached) return cached;
  const pending = LOADING.get(locale);
  if (pending) return pending;
  const loader = LOADERS[locale as keyof typeof LOADERS];
  const request = loader()
    .then((catalog) => {
      CATALOGS[locale] = catalog;
      return catalog;
    })
    .finally(() => LOADING.delete(locale));
  LOADING.set(locale, request);
  return request;
}

// The Portuguese catalog is European Portuguese; bare "pt" uses Brazilian plurals.
const PLURAL_RULES = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [
    locale,
    new Intl.PluralRules(locale === 'pt' ? 'pt-PT' : locale),
  ]),
) as Record<LocaleId, Intl.PluralRules>;

export function isLocale(value: string): value is LocaleId {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function catalogFor(locale: string): Catalog {
  return (isLocale(locale) ? CATALOGS[locale] : undefined) ?? EN;
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

export function pluralCategory(locale: LocaleId, n: number): keyof Plural {
  return PLURAL_RULES[locale].select(n);
}

export function formatMessage(message: Message, locale: LocaleId, vars?: Vars): string {
  if (typeof message === 'string') return interpolate(message, vars);
  const n = Number(vars?.['n'] ?? 0);
  const cat = pluralCategory(locale, Number.isFinite(n) ? n : 0);
  return interpolate(message[cat] ?? message.other, vars);
}

export function translate(catalog: Catalog, locale: LocaleId, key: string, vars?: Vars): string {
  const message =
    catalog[key] ?? (locale === DEFAULT_LOCALE ? undefined : EN[key as keyof typeof EN]);
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
