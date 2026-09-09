import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ReleaseInfo } from '../src/lib/api-types.ts';
import type { ThemeMode } from '../src/lib/themes.ts';
import { validAppearance, type AppearancePreferences } from '../src/lib/appearance.ts';

export interface DesktopPreferences {
  automaticUpdates: boolean;
  startWithSystem: boolean;
  journal?: string;
  window?: { width: number; height: number };
  lastUpdateCheck?: string;
  lastRelease?: ReleaseInfo;
  // The window's origin is a loopback port chosen at every launch, so its
  // localStorage never survives a restart; these choices are kept here instead.
  locale?: string;
  theme?: ThemeMode;
  appearance?: AppearancePreferences;
}

const DEFAULTS: DesktopPreferences = { automaticUpdates: true, startWithSystem: false };

export function loadPreferences(path: string): DesktopPreferences {
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DesktopPreferences>;
    return {
      automaticUpdates: raw.automaticUpdates !== false,
      startWithSystem: raw.startWithSystem === true,
      ...(typeof raw.journal === 'string' && raw.journal ? { journal: raw.journal } : {}),
      ...(validWindow(raw.window) ? { window: raw.window } : {}),
      ...(typeof raw.lastUpdateCheck === 'string' ? { lastUpdateCheck: raw.lastUpdateCheck } : {}),
      ...(validRelease(raw.lastRelease) ? { lastRelease: raw.lastRelease } : {}),
      ...(validLocale(raw.locale) ? { locale: raw.locale } : {}),
      ...(validTheme(raw.theme) ? { theme: raw.theme } : {}),
      ...(validAppearance(raw.appearance) ? { appearance: raw.appearance } : {}),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(path: string, value: DesktopPreferences): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.preferences-${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

function validWindow(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== 'object') return false;
  const window = value as Record<string, unknown>;
  return Number.isInteger(window['width']) && Number.isInteger(window['height']) && Number(window['width']) >= 720 && Number(window['height']) >= 540;
}

/** A language tag; whether a catalog exists for it is the interface's call. */
export function validLocale(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value);
}

export function validTheme(value: unknown): value is ThemeMode {
  return value === 'day' || value === 'night';
}

function validRelease(value: unknown): value is ReleaseInfo {
  if (!value || typeof value !== 'object') return false;
  const release = value as Record<string, unknown>;
  return typeof release['version'] === 'string' && typeof release['name'] === 'string' && typeof release['notes'] === 'string' && typeof release['url'] === 'string';
}
