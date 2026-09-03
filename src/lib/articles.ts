// Leading articles per target language, used by the typed-answer checker to
// forgive a missing/extra article and to flag a wrong one (gender/number).
//
// Keyed by ISO 639-1 code from journal.config.json → pair.target. Languages
// not listed here get no article handling at all, which is the safe default:
// the checker then compares the full typed string.
//
// Entries ending in an apostrophe are elided forms (Italian l', French l').
// They consume the apostrophe; all other forms must be followed by whitespace.

const ARTICLES: Record<string, readonly string[]> = {
  it: ['il', 'lo', 'la', "l'", 'i', 'gli', 'le', 'un', 'uno', 'una', "un'"],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas'],
  fr: ['le', 'la', "l'", 'les', 'un', 'une', 'des'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines'],
  nl: ['de', 'het', 'een'],
  en: ['the', 'a', 'an'],
  el: ['ο', 'η', 'το', 'οι', 'τα', 'ένας', 'μία', 'μια', 'ένα'],
  ar: ['ال'],
  he: ['ה'],
};

const cache = new Map<string, RegExp | null>();

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex matching a leading article of `lang` (plus the apostrophe or the
 * trailing whitespace that separates it from the noun), or null when the
 * language has no article table. Longer forms are tried first so "una" wins
 * over "un" and "les" over "le".
 */
export function articleRegexFor(lang: string): RegExp | null {
  const key = lang.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  const list = ARTICLES[key];
  if (!list || list.length === 0) {
    cache.set(key, null);
    return null;
  }
  const sorted = [...list].sort((a, b) => b.length - a.length);
  const elided = sorted.filter((a) => a.endsWith("'")).map((a) => escape(a.slice(0, -1)) + "['’]");
  const spaced = sorted.filter((a) => !a.endsWith("'")).map(escape);
  const alts: string[] = [];
  if (elided.length) alts.push(`(?:${elided.join('|')})`);
  if (spaced.length) alts.push(`(?:${spaced.join('|')})\\s+`);
  const re = new RegExp(`^(?:${alts.join('|')})`, 'iu');
  cache.set(key, re);
  return re;
}

/** Languages that have an article table (for docs and tests). */
export const ARTICLE_LANGUAGES: readonly string[] = Object.keys(ARTICLES).sort();
