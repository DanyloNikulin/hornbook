import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ReleaseInfo } from '../src/lib/api-types.ts';

export interface DesktopPreferences {
  automaticUpdates: boolean;
  startWithSystem: boolean;
  journal?: string;
  window?: { width: number; height: number };
  lastUpdateCheck?: string;
  lastRelease?: ReleaseInfo;
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

function validRelease(value: unknown): value is ReleaseInfo {
  if (!value || typeof value !== 'object') return false;
  const release = value as Record<string, unknown>;
  return typeof release['version'] === 'string' && typeof release['name'] === 'string' && typeof release['notes'] === 'string' && typeof release['url'] === 'string';
}
