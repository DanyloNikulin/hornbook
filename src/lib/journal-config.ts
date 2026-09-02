import { z } from 'zod';

const Iso639 = z
  .string()
  .length(2)
  .regex(/^[a-z]{2}$/);

export const ProviderConfig = z.object({
  driver: z.enum(['openai', 'anthropic', 'ollama', 'whisper-cli']),
  model: z.string().min(1),
});

export const JournalConfig = z.object({
  pair: z.object({
    target: Iso639,
    learner: Iso639,
  }),
  brand: z.object({
    name: z.string().min(1),
    tagline: z.string().min(1),
  }),
  providers: z.object({
    transcribe: ProviderConfig,
    extract: ProviderConfig,
  }),
});

export type JournalConfigT = z.infer<typeof JournalConfig>;
export type ProviderConfigT = z.infer<typeof ProviderConfig>;

/** English display names for the setup dropdown and card chips. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  uk: 'Ukrainian',
  ru: 'Russian',
  it: 'Italian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  pl: 'Polish',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  tr: 'Turkish',
  nl: 'Dutch',
  sv: 'Swedish',
  cs: 'Czech',
  el: 'Greek',
  he: 'Hebrew',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
};

export const SETUP_LANGUAGE_CODES = Object.keys(LANGUAGE_NAMES).sort();

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

export function pairLabel(target: string, learner: string): { fwd: string; rev: string } {
  const t = target.toUpperCase();
  const l = learner.toUpperCase();
  return { fwd: `${t} → ${l}`, rev: `${l} → ${t}` };
}

/** BCP-47 tags for speechSynthesis. Unknown codes pass through as-is. */
export const SPEECH_LOCALES: Record<string, string> = {
  en: 'en-US',
  uk: 'uk-UA',
  ru: 'ru-RU',
  it: 'it-IT',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  pt: 'pt-PT',
  pl: 'pl-PL',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  ar: 'ar-SA',
  tr: 'tr-TR',
  nl: 'nl-NL',
  sv: 'sv-SE',
  cs: 'cs-CZ',
  el: 'el-GR',
  he: 'he-IL',
  hi: 'hi-IN',
  th: 'th-TH',
  vi: 'vi-VN',
};

export function speechLocale(code: string): string {
  return SPEECH_LOCALES[code] ?? code;
}
