import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESET_ID,
  THEME_PRESETS,
  THEME_VARIABLE_NAMES,
  displayFontStack,
  themePreset,
  themeVariables,
} from './themes';

describe('theme presets', () => {
  it('every preset defines both modes with distinct ids', () => {
    const ids = THEME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of THEME_PRESETS) {
      for (const mode of ['day', 'night'] as const) {
        const v = p[mode];
        expect(Object.values(v).every((x) => typeof x === 'string' && x.length > 0), `${p.id}.${mode}`).toBe(true);
      }
    }
  });

  it('falls back to the default preset for an unknown or missing id', () => {
    expect(themePreset(undefined).id).toBe(DEFAULT_PRESET_ID);
    expect(themePreset('does-not-exist').id).toBe(DEFAULT_PRESET_ID);
  });
});

describe('themeVariables', () => {
  it('produces the preset colours for the requested mode', () => {
    const day = themeVariables({ preset: 'sea' }, 'day');
    const night = themeVariables({ preset: 'sea' }, 'night');
    expect(day['--primary']).toBe('#2f6f8f');
    expect(night['--primary']).toBe('#6fb0cf');
    expect(day['--backdrop-image']).toBe('none');
  });

  it('lets explicit colours override the preset', () => {
    const vars = themeVariables({ preset: 'sea', primary: '#123456', accent: '#abcdef' }, 'day');
    expect(vars['--primary']).toBe('#123456');
    expect(vars['--primary-ink']).toBe('#123456');
    expect(vars['--accent']).toBe('#abcdef');
  });

  it('only sets a display font when the id is known', () => {
    expect(themeVariables({ display_font: 'mono' }, 'day')['--font-display']).toContain('JetBrains');
    expect(themeVariables({ display_font: 'nope' }, 'day')['--font-display']).toBeUndefined();
    expect(displayFontStack(undefined)).toBeNull();
  });

  it('wraps a backdrop image in url()', () => {
    const vars = themeVariables({ backdropUrl: '/api/sections/es-en/backdrop' }, 'day');
    expect(vars['--backdrop-image']).toBe('url("/api/sections/es-en/backdrop")');
  });

  it('never emits a variable outside the declared set', () => {
    const vars = themeVariables({ preset: 'ember', primary: '#fff', display_font: 'manrope' }, 'night');
    for (const name of Object.keys(vars)) {
      expect(THEME_VARIABLE_NAMES).toContain(name);
    }
  });
});
