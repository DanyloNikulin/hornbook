import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopPreferencesView, DesktopState } from '../lib/api-types';
import { DesktopService } from './desktop.service';
import { ThemeService } from './theme.service';

// The packaged window's origin is a loopback port picked at every launch, so
// its localStorage starts empty: the desktop shell keeps the choice instead.
function desktopWith(theme?: 'day' | 'night') {
  const state = signal<DesktopState | null>({
    journal: 'C:\\Hornbook',
    platform: 'win32',
    preferences: { automaticUpdates: true, startWithSystem: false, ...(theme ? { theme } : {}) },
    update: { phase: 'idle', currentVersion: '0.9.5', installable: false },
  });
  const setPreferences = vi.fn(async (patch: Partial<DesktopPreferencesView>) => {
    state.update((current) => (current ? { ...current, preferences: { ...current.preferences, ...patch } } : current));
  });
  return { state, available: signal(true), update: signal(null), initialize: vi.fn().mockResolvedValue(undefined), setPreferences };
}

function setup(desktop?: ReturnType<typeof desktopWith>): ThemeService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: desktop ? [{ provide: DesktopService, useValue: desktop }] : [] });
  return TestBed.inject(ThemeService);
}

describe('ThemeService day/night persistence', () => {
  beforeEach(() => localStorage.removeItem('hornbook-theme'));
  afterEach(() => {
    localStorage.removeItem('hornbook-theme');
    document.documentElement.removeAttribute('data-theme');
  });

  it("restores the mode the desktop shell remembered ahead of this origin's storage", async () => {
    localStorage.setItem('hornbook-theme', 'day');
    const desktop = desktopWith('night');
    const service = setup(desktop);
    await service.initialize();
    TestBed.tick();
    expect(service.mode()).toBe('night');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
    expect(desktop.setPreferences).not.toHaveBeenCalled();
  });

  it('hands a toggled mode to the desktop shell', async () => {
    const desktop = desktopWith('day');
    const service = setup(desktop);
    await service.initialize();
    service.toggle();
    TestBed.tick();
    expect(service.mode()).toBe('night');
    expect(desktop.setPreferences).toHaveBeenCalledWith({ theme: 'night' });
    expect(localStorage.getItem('hornbook-theme')).toBe('night');
  });

  it("keeps following this origin's storage in a browser", async () => {
    localStorage.setItem('hornbook-theme', 'night');
    const service = setup();
    await service.initialize();
    expect(service.mode()).toBe('night');
  });
});
