import { articleRegexFor } from './articles.js';

// Normalize a string for forgiving typed-answer comparison: lowercase, trim,
// strip combining diacritics, unify apostrophe variants, collapse whitespace.
// Beginners shouldn't be penalized for a missing diacritic (è vs e), curly vs
// straight apostrophe, or extra spaces.
export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`ʼ]/g, "'")
    .trim()
    .replace(/\s+/g, ' ');
}

// Article handling is per target language (see ../lib/articles.ts). The
// regex matches a leading article: elided forms (l', un') eat the apostrophe,
// space-followed forms eat the trailing whitespace. `null` means the target
// language has no article table and articles are never stripped.
function stripArticle(s: string, re: RegExp | null): string {
  if (!re) return s;
  const out = s.replace(re, '');
  // Don't strip away the whole word — if the answer IS an article entry, keep it.
  return out.trim() ? out : s;
}

// Return the leading article of s (with trailing space/apostrophe), or null if
// there is none. Used to detect wrong-article (gender/number) mistakes.
function leadingArticle(s: string, re: RegExp | null): string | null {
  if (!re) return null;
  const m = s.match(re);
  return m ? m[0].trim() : null;
}

// Canonical lowercase form for comparing two articles. Curly/straight
// apostrophe are unified so "l'" (curly) and "l'" compare equal, but distinct
// articles ("il" vs "lo", "un" vs "una", "l'" vs "la") remain distinct.
function articleKey(art: string): string {
  return art.toLowerCase().replace(/[’‘`ʼ]/g, "'");
}

// Drop parenthetical hints used in vocab translations to flag gender/notes:
// "проблема (чоловічий рід!)" → "проблема".
function stripParens(s: string): string {
  return s
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Expand "X/Y" gender/number variants inside a single segment.
//   bello/a            → [bello/a, bello, bella]   (single-vowel suffix → replace stem's last vowel)
//   questo/a/i/e       → [questo, questa, questi, queste, ...]
//   lui/lei            → [lui/lei, lui, lei]       (non-vowel suffix → treat as alternative)
//   c + e/i            → [c + e/i, c + e, c + i]
// Leaves strings without "/" untouched.
function expandSlashSegment(s: string): string[] {
  if (!s.includes('/')) return [s];
  const out = new Set<string>([s]);
  const parts = s
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return [...out];
  let stem = parts[0];
  out.add(stem);
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts[i];
    const isSingleVowel = /^[aeiouаеиоуяюєїі]$/i.test(suffix);
    if (isSingleVowel && /[aeiouаеиоуяюєїі]$/i.test(stem)) {
      // Romance/Slavic gender-suffix replacement: stem ends in a vowel,
      // suffix is a single vowel → swap the last vowel.
      const variant = stem.slice(0, -1) + suffix;
      out.add(variant);
      stem = variant; // chain: "questo/a/i/e" → questo, questa, questi, queste
    } else if (isSingleVowel && /[иі]й$/i.test(stem)) {
      // Ukrainian masculine adjective ending "-ий"/"-ій" → drop the ending,
      // append the suffix: щасливий/а → щаслива, щасливий/е → щасливе.
      // Chain after the first drop: subsequent vowel suffixes then follow the
      // standard vowel-swap rule on the new (already vowel-ending) stem, so
      // "гарний/а/е/і" expands to гарна, гарне, гарні.
      const variant = stem.slice(0, -2) + suffix;
      out.add(variant);
      stem = variant;
    } else {
      out.add(suffix);
    }
  }
  return [...out];
}

// All acceptable text forms of an expected answer: the original, parenthetical
// hints stripped, each comma/semicolon/" / "-separated meaning, each gender
// slash variant, plus article-stripped versions of each.
function expandForms(expected: string, articleRe: RegExp | null): Set<string> {
  const out = new Set<string>();
  const sources = [expected.trim(), stripParens(expected)];
  for (const src of sources) {
    if (!src) continue;
    out.add(src);
    // Multi-meaning separators: comma, semicolon, or ' / ' (with spaces).
    const parts = src.split(/\s*[,;]\s*|\s+\/\s+/);
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      for (const e of expandSlashSegment(p)) {
        const et = e.trim();
        if (et) out.add(et);
      }
    }
  }
  // Article-stripped variants of every collected form.
  for (const f of [...out]) {
    const stripped = stripArticle(f, articleRe).trim();
    if (stripped && stripped !== f) out.add(stripped);
  }
  return out;
}

export type TypedResult = 'exact' | 'close' | 'wrong';

/**
 * Grade a typed answer against the expected text. `lang` is the ISO 639-1
 * code of the target language (journal.config.json → pair.target); it selects
 * the article table used to forgive a missing/extra article and to flag a
 * wrong one. Pass an unknown code (or omit it) to disable article handling.
 */
export function checkTypedAnswer(typed: string, expected: string, lang = ''): TypedResult {
  if (!typed.trim()) return 'wrong';
  const articleRe = articleRegexFor(lang);
  const forms = expandForms(expected, articleRe);
  const t = typed.trim();

  // Tier 1: typed matches a form verbatim → 'exact'.
  if (forms.has(t)) return 'exact';

  // Precompute normalized lookup once — reused by Tier 2 and Tier 4.
  const normalized = new Set<string>();
  for (const f of forms) {
    const n = normalizeAnswer(f);
    if (n) normalized.add(n);
  }
  const tn = normalizeAnswer(t);

  // Tier 2: normalized match (case/diacritic/apostrophe differences) → 'close'.
  if (tn && normalized.has(tn)) return 'close';

  // Tier 3: typed with leading article stripped matches a form verbatim.
  //   - If no form had any article, user just added a stray one → 'exact'.
  //   - If typed's article matches one of the forms' articles → 'exact'.
  //   - If typed used a different article (wrong gender/form) → 'close'.
  const tStripped = stripArticle(t, articleRe).trim();
  if (tStripped && tStripped !== t && forms.has(tStripped)) {
    const typArt = leadingArticle(t, articleRe);
    if (!typArt) return 'exact';
    const typKey = articleKey(typArt);
    const formArticleKeys = new Set<string>();
    for (const f of forms) {
      const a = leadingArticle(f, articleRe);
      if (a) formArticleKeys.add(articleKey(a));
    }
    if (formArticleKeys.size === 0) return 'exact';
    return formArticleKeys.has(typKey) ? 'exact' : 'close';
  }

  // Tier 4: normalized match after stripping typed's article → 'close'.
  if (tStripped && tStripped !== t) {
    const tns = normalizeAnswer(tStripped);
    if (tns && normalized.has(tns)) return 'close';
  }

  return 'wrong';
}
