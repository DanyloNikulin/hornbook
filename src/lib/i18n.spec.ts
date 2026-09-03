import { describe, expect, it } from 'vitest';
import { EN } from './i18n.en';
import { IT } from './i18n.it';
import {
  DEFAULT_LOCALE,
  catalogFor,
  formatMessage,
  interpolate,
  isLocale,
  nextLocale,
  pluralCategory,
  t,
  translate,
} from './i18n';

describe('i18n engine', () => {
  it('treats en as the default and it as a second locale', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('it')).toBe(true);
    expect(isLocale('ru')).toBe(false);
    expect(catalogFor('ru')).toBe(catalogFor('en'));
    expect(nextLocale('en')).toBe('it');
    expect(nextLocale('it')).toBe('en');
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
