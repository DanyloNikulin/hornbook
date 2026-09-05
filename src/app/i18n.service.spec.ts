import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as catalogs from '../lib/i18n';
import { EN } from '../lib/i18n.en';
import { I18nService, LOCALE_LOADER } from './i18n.service';

const loadLocale = vi.fn<typeof catalogs.loadCatalog>();

function deferredCatalog() {
  let resolve!: (catalog: catalogs.Catalog) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<catalogs.Catalog>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('I18nService language loading', () => {
  beforeEach(() => {
    localStorage.removeItem('hornbook-locale');
    TestBed.configureTestingModule({
      providers: [{ provide: LOCALE_LOADER, useValue: loadLocale }],
    });
    loadLocale.mockReset().mockResolvedValue(EN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem('hornbook-locale');
  });

  it('restores a saved language before completing initialization', async () => {
    localStorage.setItem('hornbook-locale', 'fr');
    const pending = deferredCatalog();
    loadLocale.mockReturnValueOnce(pending.promise);
    const service = TestBed.inject(I18nService);
    const initializing = service.initialize();
    TestBed.tick();
    expect(localStorage.getItem('hornbook-locale')).toBe('fr');
    pending.resolve(EN);
    await initializing;
    TestBed.tick();
    expect(service.locale()).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
  });

  it('keeps the newest selection when earlier loading finishes later', async () => {
    const first = deferredCatalog();
    loadLocale.mockReturnValueOnce(first.promise);
    const service = TestBed.inject(I18nService);
    const older = service.set('es');
    await service.set('sv');
    first.resolve(EN);
    await older;
    TestBed.tick();
    expect(service.locale()).toBe('sv');
    expect(localStorage.getItem('hornbook-locale')).toBe('sv');
  });

  it('keeps the current language on failure and allows another attempt', async () => {
    const service = TestBed.inject(I18nService);
    await service.set('it');
    loadLocale.mockRejectedValueOnce(new Error('Unavailable chunk'));
    await service.set('nl');
    TestBed.tick();
    expect(service.locale()).toBe('it');
    expect(service.loadFailed()).toBe(true);
    expect(localStorage.getItem('hornbook-locale')).toBe('it');
    await service.set('nl');
    TestBed.tick();
    expect(service.loadFailed()).toBe(false);
    expect(service.locale()).toBe('nl');
  });

  it('ignores a stale failure after selecting a bundled language', async () => {
    const first = deferredCatalog();
    loadLocale.mockReturnValueOnce(first.promise);
    const service = TestBed.inject(I18nService);
    const older = service.set('de');
    await service.set('it');
    first.reject(new Error('Unavailable chunk'));
    await older;
    expect(service.locale()).toBe('it');
    expect(service.loadFailed()).toBe(false);
  });

  it('falls back safely at startup without losing the saved preference', async () => {
    localStorage.setItem('hornbook-locale', 'pt');
    loadLocale.mockRejectedValueOnce(new Error('Unavailable chunk'));
    const service = TestBed.inject(I18nService);
    await service.initialize();
    TestBed.tick();
    expect(service.locale()).toBe('en');
    expect(service.loadFailed()).toBe(true);
    expect(localStorage.getItem('hornbook-locale')).toBe('pt');
  });
});
