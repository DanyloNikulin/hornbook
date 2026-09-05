import { beforeAll, describe, expect, it } from 'vitest';
import { EN } from './i18n.en';
import { IT } from './i18n.it';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  loadCatalog,
  catalogFor,
  formatMessage,
  interpolate,
  isLocale,
  isStockTagline,
  nextLocale,
  pluralCategory,
  t,
  translate,
} from './i18n';

describe('i18n engine', () => {
  beforeAll(async () => {
    await Promise.all(SUPPORTED_LOCALES.map(loadCatalog));
  });
  it('keeps English as the default and cycles through every supported locale', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('it')).toBe(true);
    expect(isLocale('ru')).toBe(false);
    expect(catalogFor('ru')).toBe(catalogFor('en'));
    expect(nextLocale('en')).toBe('it');
    for (const [index, locale] of SUPPORTED_LOCALES.entries()) {
      expect(isLocale(locale)).toBe(true);
      expect(nextLocale(locale)).toBe(SUPPORTED_LOCALES[(index + 1) % SUPPORTED_LOCALES.length]);
    }
  });

  it('interpolates named tokens and leaves unknown ones', () => {
    expect(interpolate('Hello {name}', { name: 'Alex' })).toBe('Hello Alex');
    expect(interpolate('Hello {name}', {})).toBe('Hello {name}');
    expect(interpolate('plain', { name: 'x' })).toBe('plain');
  });

  it('uses one/other for English and Italian plurals', () => {
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('it', 1)).toBe('one');
    expect(pluralCategory('en', 0)).toBe('other');
    expect(pluralCategory('it', 2)).toBe('other');
    const msg = { one: '{n} lesson', other: '{n} lessons' };
    expect(formatMessage(msg, 'en', { n: 1 })).toBe('1 lesson');
    expect(formatMessage(msg, 'en', { n: 3 })).toBe('3 lessons');
  });

  it('returns the key when a message is missing from every catalog', () => {
    expect(translate({}, 'en', 'no.such.key')).toBe('no.such.key');
  });

  it('falls back to English when a locale omits a key', () => {
    expect(translate({}, 'it', 'nav.lessons')).toBe('Lessons');
  });

  it('looks up English and Italian catalogs', () => {
    expect(t('nav.lessons')).toBe('Lessons');
    expect(t('nav.lessons', undefined, 'it')).toBe('Lezioni');
    expect(t('count.lessons', { n: 1 })).toBe('1 lesson');
    expect(t('count.lessons', { n: 4 }, 'it')).toBe('4 lezioni');
    expect(t('file.choose')).toBe('Choose file');
    expect(t('file.choose', undefined, 'it')).toBe('Scegli file');
    expect(t('nav.homeAria', { brand: 'Hornbook' })).toBe('Hornbook — home');
  });

  it('keeps the Italian catalog in lockstep with English keys', () => {
    expect(Object.keys(IT).sort()).toEqual(Object.keys(EN).sort());
  });

  it.each(SUPPORTED_LOCALES)(
    '%s has every message and preserves interpolation variables',
    (locale) => {
      const catalog = catalogFor(locale);
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(EN).sort());
      const tokens = (value: string) =>
        [...value.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]).sort();
      for (const [key, source] of Object.entries(EN)) {
        const message = catalog[key];
        expect(typeof message, key).toBe(typeof source);
        if (typeof source === 'string' && typeof message === 'string') {
          expect(message.trim(), key).not.toBe('');
          expect(tokens(message), key).toEqual(tokens(source));
        } else if (typeof source !== 'string' && typeof message !== 'string') {
          for (const category of Object.keys(source)) {
            expect(message[category as keyof typeof message], `${key}.${category}`).toBeDefined();
          }
          for (const [category, translated] of Object.entries(message)) {
            const text = (source as Partial<Record<string, string>>)[category] ?? source.other;
            expect(translated.trim(), `${key}.${category}`).toBeTruthy();
            // Singular categories can include zero (French) or 21, 31, etc. (Ukrainian).
            const reference =
              category === 'one' && translated?.includes('{n}')
                ? text.replace(/\b1\b/, '{n}')
                : text;
            expect(tokens(translated), `${key}.${category}`).toEqual(tokens(reference));
          }
        }
      }
    },
  );

  it('uses French and European Portuguese plural rules for zero and fractions', () => {
    expect(t('count.words', { n: 0 }, 'fr')).toBe('0 mot');
    expect(t('count.words', { n: 1 }, 'fr')).toBe('1 mot');
    expect(t('count.words', { n: 2 }, 'fr')).toBe('2 mots');
    expect(t('count.words', { n: 1.5 }, 'fr')).toBe('1.5 mot');
    expect(t('count.words', { n: 0 }, 'pt')).toBe('0 palavras');
    expect(t('count.words', { n: 1 }, 'pt')).toBe('1 palavra');
    expect(t('count.words', { n: 1.5 }, 'pt')).toBe('1.5 palavras');
    expect(t('transfer.pairConflictTitle', { n: 0 }, 'fr')).toBe('0 cours est déjà présent');
    expect(t('quiz.saveScorePending', { n: 0 }, 'fr')).toContain('0 traduction');
    expect(t('count.words', { n: 1_000_000 }, 'fr')).toBe('1000000 mots');
  });

  it.each([
    [0, '0 уроків'],
    [1, '1 урок'],
    [2, '2 уроки'],
    [4, '4 уроки'],
    [5, '5 уроків'],
    [11, '11 уроків'],
    [12, '12 уроків'],
    [14, '14 уроків'],
    [21, '21 урок'],
    [22, '22 уроки'],
    [25, '25 уроків'],
    [101, '101 урок'],
    [111, '111 уроків'],
    [1.5, '1.5 уроку'],
  ])('formats Ukrainian lesson count %s as %s', (n, expected) => {
    expect(t('count.lessons', { n }, 'uk')).toBe(expected);
  });

  it('provides all four Ukrainian plural forms, including dynamic singular counts', () => {
    for (const [key, message] of Object.entries(catalogFor('uk'))) {
      if (typeof message === 'string') continue;
      expect(Object.keys(message).sort(), key).toEqual(['few', 'many', 'one', 'other']);
    }
    expect(t('transfer.pairConflictTitle', { n: 21 }, 'uk')).toBe('21 урок уже є');
    expect(t('transfer.pairConflictTitle', { n: 22 }, 'uk')).toBe('22 уроки вже є');
    expect(t('quiz.pendingTranslations', { n: 21 }, 'uk')).toContain('21 переклад.');
    expect(t('quiz.saveScorePending', { n: 22 }, 'uk')).toContain('22 переклади');
    expect(t('quiz.saveScorePending', { n: 11 }, 'uk')).toContain('11 перекладів');
    expect(t('unit.days', { n: 1.5 }, 'uk')).toBe('дня');
  });

  it('localizes the stock demo tagline and leaves a custom one alone', () => {
    expect(isStockTagline('conspects from your lessons')).toBe(true);
    expect(isStockTagline('  Conspects from your lessons  ')).toBe(true);
    expect(isStockTagline('Italian with Marta')).toBe(false);
    expect(t('brand.defaultTagline', undefined, 'it')).toBe('sunti dalle tue lezioni');
  });

  it('covers every theme preset name and every connection-help key', () => {
    for (const id of ['paper', 'olive', 'sea', 'plum', 'ember', 'ink']) {
      expect(EN[`theme.${id}.name` as keyof typeof EN]).toBeTruthy();
      expect(EN[`theme.${id}.note` as keyof typeof EN]).toBeTruthy();
    }
    for (const key of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OLLAMA_HOST',
      'WHISPER_BIN',
      'WHISPER_MODEL',
    ]) {
      expect(EN[`settings.conn.${key}` as keyof typeof EN]).toBeTruthy();
    }
  });
});
