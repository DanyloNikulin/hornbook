// Bundled looks for a section. A preset is a small set of colour tokens for
// each of the two modes (day and night), so a pair can feel like its language
// without breaking either mode. Applied as CSS variables on the root element
// by ThemeService; `paper` reproduces the palette the app has always had.

export interface ThemeVars {
  /** Buttons, links, active chips. */
  primary: string;
  /** Text-on-paper variant of primary; must stay readable on --paper. */
  primaryInk: string;
  /** Secondary highlight (badges, rules). */
  accent: string;
  /** Top of the page backdrop gradient. */
  backdropTop: string;
  /** Colour of the soft glow at the top of the backdrop. */
  backdropGlow: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  /** One line shown under the name in the picker. */
  note: string;
  day: ThemeVars;
  night: ThemeVars;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'paper',
    name: 'Paper',
    note: 'Warm terracotta on old paper — the Hornbook default.',
    day: { primary: '#c0653f', primaryInk: '#8e3f1f', accent: '#b4884a', backdropTop: '#2c3539', backdropGlow: 'rgba(31, 78, 95, 0.28)' },
    night: { primary: '#8aaccc', primaryInk: '#a3c0da', accent: '#8aaccc', backdropTop: '#12100e', backdropGlow: 'rgba(138, 172, 204, 0.18)' },
  },
  {
    id: 'olive',
    name: 'Olive grove',
    note: 'Green and gold, southern and sunlit.',
    day: { primary: '#6b8e4e', primaryInk: '#4a6635', accent: '#c9a227', backdropTop: '#33402c', backdropGlow: 'rgba(107, 142, 78, 0.30)' },
    night: { primary: '#9dbd7a', primaryInk: '#b4cf95', accent: '#d4b95e', backdropTop: '#12140f', backdropGlow: 'rgba(157, 189, 122, 0.16)' },
  },
  {
    id: 'sea',
    name: 'Deep sea',
    note: 'Blue and coral, cool and quiet.',
    day: { primary: '#2f6f8f', primaryInk: '#1e4d66', accent: '#d2725b', backdropTop: '#1f3a49', backdropGlow: 'rgba(47, 111, 143, 0.32)' },
    night: { primary: '#6fb0cf', primaryInk: '#8ec6e0', accent: '#e08a72', backdropTop: '#0d1418', backdropGlow: 'rgba(111, 176, 207, 0.18)' },
  },
  {
    id: 'plum',
    name: 'Plum',
    note: 'Purple and rose, evening study.',
    day: { primary: '#7a4a78', primaryInk: '#5b3459', accent: '#c2708f', backdropTop: '#3a2b3d', backdropGlow: 'rgba(122, 74, 120, 0.30)' },
    night: { primary: '#b98cb6', primaryInk: '#cba6c8', accent: '#d992a9', backdropTop: '#151016', backdropGlow: 'rgba(185, 140, 182, 0.18)' },
  },
  {
    id: 'ember',
    name: 'Ember',
    note: 'Red and amber, high contrast.',
    day: { primary: '#b23a2f', primaryInk: '#8a2a21', accent: '#d98324', backdropTop: '#3b2723', backdropGlow: 'rgba(178, 58, 47, 0.30)' },
    night: { primary: '#e0705f', primaryInk: '#ee8a7a', accent: '#e8a04a', backdropTop: '#160f0d', backdropGlow: 'rgba(224, 112, 95, 0.18)' },
  },
  {
    id: 'ink',
    name: 'Ink',
    note: 'Near-monochrome, nothing competes with the text.',
    day: { primary: '#4a4039', primaryInk: '#2a2520', accent: '#7a6f64', backdropTop: '#2f2c29', backdropGlow: 'rgba(74, 64, 57, 0.26)' },
    night: { primary: '#bdb2a0', primaryInk: '#d9c9a8', accent: '#9c8f78', backdropTop: '#111010', backdropGlow: 'rgba(217, 201, 168, 0.12)' },
  },
];

export const DEFAULT_PRESET_ID = 'paper';

export type ThemeMode = 'day' | 'night';

export function themePreset(id: string | undefined): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0];
}

export const THEME_PRESET_IDS: readonly string[] = THEME_PRESETS.map((p) => p.id);

/** Display fonts a section may choose. All are bundled — no runtime downloads. */
export const DISPLAY_FONTS: readonly { id: string; name: string; stack: string }[] = [
  { id: 'cormorant', name: 'Cormorant Garamond', stack: '"Cormorant Garamond", "Cormorant", Georgia, serif' },
  { id: 'manrope', name: 'Manrope', stack: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  { id: 'mono', name: 'JetBrains Mono', stack: '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace' },
];

export const DISPLAY_FONT_IDS: readonly string[] = DISPLAY_FONTS.map((f) => f.id);

export function displayFontStack(id: string | undefined): string | null {
  return DISPLAY_FONTS.find((f) => f.id === id)?.stack ?? null;
}

export interface AppliedTheme {
  preset?: string;
  primary?: string;
  accent?: string;
  display_font?: string;
  /** File name of the section's backdrop image, as stored in the config. */
  backdrop?: string;
  /** URL that image is served from, or undefined for the plain gradient. */
  backdropUrl?: string;
}

/**
 * CSS custom properties for a section's look in one mode. Overrides win over
 * the preset; an unset value falls back to the preset, and an unknown preset
 * falls back to `paper`, so a hand-edited config can never blank the UI.
 */
export function themeVariables(theme: AppliedTheme | undefined, mode: ThemeMode): Record<string, string> {
  const preset = themePreset(theme?.preset);
  const base = mode === 'night' ? preset.night : preset.day;
  const vars: Record<string, string> = {
    '--primary': theme?.primary || base.primary,
    '--primary-ink': theme?.primary || base.primaryInk,
    '--accent': theme?.accent || base.accent,
    '--backdrop-top': base.backdropTop,
    '--backdrop-glow': base.backdropGlow,
    '--backdrop-image': theme?.backdropUrl ? `url("${theme.backdropUrl}")` : 'none',
  };
  const font = displayFontStack(theme?.display_font);
  if (font) vars['--font-display'] = font;
  return vars;
}

/** Variables the theme layer owns; cleared when leaving a section. */
export const THEME_VARIABLE_NAMES: readonly string[] = [
  '--primary',
  '--primary-ink',
  '--accent',
  '--backdrop-top',
  '--backdrop-glow',
  '--backdrop-image',
  '--font-display',
];
