import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppearanceService } from './appearance.service';
import { DesktopService } from './desktop.service';
import { DEFAULT_APPEARANCE } from '../lib/appearance';

beforeEach(() => localStorage.removeItem('hornbook-appearance'));
afterEach(() => {
  TestBed.resetTestingModule();
  localStorage.removeItem('hornbook-appearance');
  document.documentElement.removeAttribute('data-reduce-transparency');
  document.documentElement.removeAttribute('data-increase-contrast');
  document.documentElement.style.fontSize = '';
});

it('restores browser choices and scales relative to the browser text preference', async () => {
  localStorage.setItem(
    'hornbook-appearance',
    JSON.stringify({ ...DEFAULT_APPEARANCE, textScale: 150 }),
  );
  const service = TestBed.inject(AppearanceService);
  await service.initialize();
  service.set({ reduceTransparency: true, increaseContrast: true });
  TestBed.tick();
  expect(document.documentElement.style.fontSize).toBe('150%');
  expect(document.documentElement.hasAttribute('data-reduce-transparency')).toBe(true);
  expect(document.documentElement.hasAttribute('data-increase-contrast')).toBe(true);
  expect(JSON.parse(localStorage.getItem('hornbook-appearance')!)).toEqual(service.preferences());
  service.set({ textScale: 100, reduceTransparency: false });
  TestBed.tick();
  expect(document.documentElement.style.fontSize).toBe('');
  expect(document.documentElement.hasAttribute('data-reduce-transparency')).toBe(false);
});

it('prefers desktop choices on a new origin and recovers from a failed preference write', async () => {
  const remembered = { ...DEFAULT_APPEARANCE, textScale: 125 as const };
  const desktop = {
    initialize: vi.fn().mockResolvedValue(undefined),
    available: signal(true),
    state: signal({ preferences: { appearance: remembered } }),
    setPreferences: vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({ providers: [{ provide: DesktopService, useValue: desktop }] });
  const service = TestBed.inject(AppearanceService);
  await service.initialize();
  expect(service.preferences()).toEqual(remembered);
  service.set({ increaseContrast: true });
  await vi.waitFor(() => expect(service.saveFailed()).toBe(true));
  service.set({ reduceTransparency: true });
  await vi.waitFor(() => expect(service.saveFailed()).toBe(false));
  expect(desktop.setPreferences).toHaveBeenLastCalledWith({ appearance: service.preferences() });
});

it('discards malformed stored preferences', () => {
  localStorage.setItem('hornbook-appearance', '{"textScale":900}');
  expect(TestBed.inject(AppearanceService).preferences()).toEqual(DEFAULT_APPEARANCE);
});
