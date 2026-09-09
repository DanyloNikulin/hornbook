import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as catalogs from '../lib/i18n';
import { EN } from '../lib/i18n.en';
import { I18nService, LOCALE_LOADER } from './i18n.service';
import { DesktopService } from './desktop.service';
import type { DesktopPreferencesView, DesktopState } from '../lib/api-types';

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
  beforeAll(async () => {
    // Other suites may have filled the shared cache before these loading tests.
    await Promise.all(catalogs.SUPPORTED_LOCALES.map(catalogs.loadCatalog));
  });

  beforeEach(() => {
    localStorage.removeItem('hornbook-locale');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LOCALE_LOADER,
          useValue: {
            load: loadLocale,
            isLoaded: (locale: catalogs.LocaleId) => locale === 'en' || locale === 'it',
          },
        },
      ],
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

// The packaged window's origin is a loopback port picked at every launch, so
// its localStorage starts empty: the desktop shell keeps the choice instead.
describe('I18nService in the desktop shell', () => {
  function desktopWith(locale?: string) {
    const state = signal<DesktopState | null>({
      journal: 'C:\\Hornbook',
      platform: 'win32',
      preferences: { automaticUpdates: true, startWithSystem: false, ...(locale ? { locale } : {}) },
      update: { phase: 'idle', currentVersion: '0.9.5', installable: false },
    });
    const setPreferences = vi.fn(async (patch: Partial<DesktopPreferencesView>) => {
      state.update((current) => (current ? { ...current, preferences: { ...current.preferences, ...patch } } : current));
    });
    return { state, available: signal(true), update: signal(null), initialize: vi.fn().mockResolvedValue(undefined), setPreferences };
  }

  function setup(desktop: ReturnType<typeof desktopWith>): I18nService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopService, useValue: desktop },
        { provide: LOCALE_LOADER, useValue: { load: () => Promise.resolve(EN), isLoaded: () => true } },
      ],
    });
    return TestBed.inject(I18nService);
  }

  beforeEach(() => localStorage.removeItem('hornbook-locale'));
  afterEach(() => localStorage.removeItem('hornbook-locale'));

  it('restores the language the desktop shell remembered ahead of this origin\'s storage', async () => {
    localStorage.setItem('hornbook-locale', 'fr');
    const desktop = desktopWith('uk');
    const service = setup(desktop);
    await service.initialize();
    TestBed.tick();
    expect(service.locale()).toBe('uk');
    expect(document.documentElement.lang).toBe('uk');
    expect(desktop.setPreferences).not.toHaveBeenCalled();
  });

  it('ignores a remembered tag that has no catalog', async () => {
    localStorage.setItem('hornbook-locale', 'fr');
    const service = setup(desktopWith('tlh'));
    await service.initialize();
    expect(service.locale()).toBe('fr');
  });

  it('hands a language chosen in this window to the desktop shell, once', async () => {
    const desktop = desktopWith();
    const service = setup(desktop);
    await service.initialize();
    expect(desktop.setPreferences).not.toHaveBeenCalled();
    await service.set('it');
    expect(desktop.setPreferences).toHaveBeenCalledWith({ locale: 'it' });
    await service.set('it');
    expect(desktop.setPreferences).toHaveBeenCalledTimes(1);
  });
});
