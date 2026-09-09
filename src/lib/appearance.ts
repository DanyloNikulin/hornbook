/** Optional accessibility overrides; system preferences remain the baseline. */
export interface AppearancePreferences {
  reduceTransparency: boolean;
  increaseContrast: boolean;
  textScale: 100 | 125 | 150;
}

export const DEFAULT_APPEARANCE: Readonly<AppearancePreferences> = {
  reduceTransparency: false,
  increaseContrast: false,
  textScale: 100,
};

export function validAppearance(value: unknown): value is AppearancePreferences {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input['reduceTransparency'] === 'boolean' &&
    typeof input['increaseContrast'] === 'boolean' &&
    [100, 125, 150].includes(Number(input['textScale'])) &&
    typeof input['textScale'] === 'number'
  );
}
