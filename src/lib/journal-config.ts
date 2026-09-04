import { z } from 'zod';
import { languageName, speechLocale } from './languages.js';

export { languageName, speechLocale, LANGUAGE_CODES as SETUP_LANGUAGE_CODES } from './languages.js';

const Iso639 = z
  .string()
  .length(2)
  .regex(/^[a-z]{2}$/);

const SectionIdRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ProviderConfig = z.object({
  driver: z.enum([
    'openai',
    'anthropic',
    'ollama',
    'whisper-cli',
    'skip',
    'claude-cli',
    'codex-cli',
    'grok-cli',
    'kimi-cli',
  ]),
  model: z.string().min(1),
});

export const Providers = z.object({
  transcribe: ProviderConfig,
  extract: ProviderConfig,
});

/**
 * Per-section look. `preset` names a bundled theme (src/lib/themes.ts);
 * `primary` / `accent` / `display_font` override it; `backdrop` is the file
 * name of an image stored in the section folder and served by the API.
 */
export const SectionTheme = z.object({
  preset: z.string().max(40).optional(),
  backdrop: z.string().max(120).optional(),
  primary: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  display_font: z.string().max(40).optional(),
});

/**
 * One language pair. `id` is the folder name under the journal and the URL
 * prefix in the app; by default `<target>-<learner>`.
 */
export const SectionConfig = z.object({
  id: z.string().regex(SectionIdRegex),
  target: Iso639,
  learner: Iso639,
  title: z.string().min(1).optional(),
  theme: SectionTheme.optional(),
  /** Per-section provider override; falls back to the journal-level providers. */
  providers: Providers.partial().optional(),
});

/**
 * journal.config.json. `sections` is the current shape; a legacy `pair`
 * (single pair per journal) is still accepted and normalised into one
 * section by `normalizeJournalConfig`.
 */
export const JournalConfig = z.object({
  brand: z.object({
    name: z.string().min(1),
    tagline: z.string().min(1),
  }),
  providers: Providers,
  sections: z.array(SectionConfig).default([]),
  pair: z
    .object({
      target: Iso639,
      learner: Iso639,
    })
    .optional(),
});

export type JournalConfigT = z.infer<typeof JournalConfig>;
export type SectionConfigT = z.infer<typeof SectionConfig>;
export type SectionThemeT = z.infer<typeof SectionTheme>;
export type ProviderConfigT = z.infer<typeof ProviderConfig>;
export type ProvidersT = z.infer<typeof Providers>;

export function sectionIdFor(target: string, learner: string): string {
  return `${target}-${learner}`;
}

/**
 * Parse and normalise a raw config: a legacy `pair` becomes the only section
 * (unless a section with the same id already exists), and `pair` is dropped.
 * Throws on invalid input.
 */
export function normalizeJournalConfig(raw: unknown): JournalConfigT {
  const parsed = JournalConfig.parse(raw);
  const sections = [...parsed.sections];
  if (parsed.pair) {
    const id = sectionIdFor(parsed.pair.target, parsed.pair.learner);
    if (!sections.some((s) => s.id === id)) {
      sections.unshift({ id, target: parsed.pair.target, learner: parsed.pair.learner });
    }
  }
  const ids = new Set<string>();
  for (const s of sections) {
    if (ids.has(s.id)) throw new Error(`journal.config.json: duplicate section id "${s.id}"`);
    ids.add(s.id);
  }
  return { brand: parsed.brand, providers: parsed.providers, sections };
}

/** Effective providers for a section: section override on top of journal defaults. */
export function providersFor(config: JournalConfigT, section: SectionConfigT): ProvidersT {
  return {
    transcribe: section.providers?.transcribe ?? config.providers.transcribe,
    extract: section.providers?.extract ?? config.providers.extract,
  };
}

/** Human title for a section: explicit title, else "Spanish → English". */
export function sectionTitle(section: Pick<SectionConfigT, 'target' | 'learner' | 'title'>): string {
  return section.title ?? `${languageName(section.target)} → ${languageName(section.learner)}`;
}

export function pairLabel(target: string, learner: string): { fwd: string; rev: string } {
  const t = target.toUpperCase();
  const l = learner.toUpperCase();
  return { fwd: `${t} → ${l}`, rev: `${l} → ${t}` };
}

export function sectionSpeechLocale(section: Pick<SectionConfigT, 'target'>): string {
  return speechLocale(section.target);
}
