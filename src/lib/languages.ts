// Bundled language catalogue for section setup. Static on purpose: no
// runtime download, no external images (the CSP only allows same-origin
// assets). Flags are emoji and belong to countries, not languages, so the
// UI shows them as decoration next to the native name, which is the real
// identifier.

export interface LanguageInfo {
  /** ISO 639-1 code. */
  code: string;
  /** English name. */
  name: string;
  /** Name in the language itself. */
  native: string;
  /** Emoji flag used as decoration. */
  flag: string;
  /** BCP-47 tag for speechSynthesis. */
  speech: string;
  /** Text direction. */
  dir: 'ltr' | 'rtl';
}

const L = (
  code: string,
  name: string,
  native: string,
  flag: string,
  speech: string,
  dir: 'ltr' | 'rtl' = 'ltr',
): LanguageInfo => ({ code, name, native, flag, speech, dir });

export const LANGUAGES: readonly LanguageInfo[] = [
  L('ar', 'Arabic', 'العربية', '🇸🇦', 'ar-SA', 'rtl'),
  L('bg', 'Bulgarian', 'Български', '🇧🇬', 'bg-BG'),
  L('ca', 'Catalan', 'Català', '🇦🇩', 'ca-ES'),
  L('cs', 'Czech', 'Čeština', '🇨🇿', 'cs-CZ'),
  L('da', 'Danish', 'Dansk', '🇩🇰', 'da-DK'),
  L('de', 'German', 'Deutsch', '🇩🇪', 'de-DE'),
  L('el', 'Greek', 'Ελληνικά', '🇬🇷', 'el-GR'),
  L('en', 'English', 'English', '🇬🇧', 'en-US'),
  L('es', 'Spanish', 'Español', '🇪🇸', 'es-ES'),
  L('et', 'Estonian', 'Eesti', '🇪🇪', 'et-EE'),
  L('fa', 'Persian', 'فارسی', '🇮🇷', 'fa-IR', 'rtl'),
  L('fi', 'Finnish', 'Suomi', '🇫🇮', 'fi-FI'),
  L('fr', 'French', 'Français', '🇫🇷', 'fr-FR'),
  L('he', 'Hebrew', 'עברית', '🇮🇱', 'he-IL', 'rtl'),
  L('hi', 'Hindi', 'हिन्दी', '🇮🇳', 'hi-IN'),
  L('hr', 'Croatian', 'Hrvatski', '🇭🇷', 'hr-HR'),
  L('hu', 'Hungarian', 'Magyar', '🇭🇺', 'hu-HU'),
  L('id', 'Indonesian', 'Bahasa Indonesia', '🇮🇩', 'id-ID'),
  L('it', 'Italian', 'Italiano', '🇮🇹', 'it-IT'),
  L('ja', 'Japanese', '日本語', '🇯🇵', 'ja-JP'),
  L('ka', 'Georgian', 'ქართული', '🇬🇪', 'ka-GE'),
  L('ko', 'Korean', '한국어', '🇰🇷', 'ko-KR'),
  L('lt', 'Lithuanian', 'Lietuvių', '🇱🇹', 'lt-LT'),
  L('lv', 'Latvian', 'Latviešu', '🇱🇻', 'lv-LV'),
  L('nl', 'Dutch', 'Nederlands', '🇳🇱', 'nl-NL'),
  L('no', 'Norwegian', 'Norsk', '🇳🇴', 'nb-NO'),
  L('pl', 'Polish', 'Polski', '🇵🇱', 'pl-PL'),
  L('pt', 'Portuguese', 'Português', '🇵🇹', 'pt-PT'),
  L('ro', 'Romanian', 'Română', '🇷🇴', 'ro-RO'),
  L('ru', 'Russian', 'Русский', '🇷🇺', 'ru-RU'),
  L('sk', 'Slovak', 'Slovenčina', '🇸🇰', 'sk-SK'),
  L('sl', 'Slovenian', 'Slovenščina', '🇸🇮', 'sl-SI'),
  L('sr', 'Serbian', 'Српски', '🇷🇸', 'sr-RS'),
  L('sv', 'Swedish', 'Svenska', '🇸🇪', 'sv-SE'),
  L('sw', 'Swahili', 'Kiswahili', '🇰🇪', 'sw-KE'),
  L('th', 'Thai', 'ไทย', '🇹🇭', 'th-TH'),
  L('tr', 'Turkish', 'Türkçe', '🇹🇷', 'tr-TR'),
  L('uk', 'Ukrainian', 'Українська', '🇺🇦', 'uk-UA'),
  L('vi', 'Vietnamese', 'Tiếng Việt', '🇻🇳', 'vi-VN'),
  L('zh', 'Chinese', '中文', '🇨🇳', 'zh-CN'),
];

const BY_CODE: ReadonlyMap<string, LanguageInfo> = new Map(LANGUAGES.map((l) => [l.code, l]));

export function languageInfo(code: string): LanguageInfo | undefined {
  return BY_CODE.get(code.toLowerCase());
}

/** English display name; unknown codes fall back to the upper-cased code. */
export function languageName(code: string): string {
  return languageInfo(code)?.name ?? code.toUpperCase();
}

export function languageFlag(code: string): string {
  return languageInfo(code)?.flag ?? '🏳️';
}

/** BCP-47 tag for speechSynthesis. Unknown codes pass through as-is. */
export function speechLocale(code: string): string {
  return languageInfo(code)?.speech ?? code;
}

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);
