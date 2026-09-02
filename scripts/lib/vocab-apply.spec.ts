import { describe, it, expect } from 'vitest';
import {
  addToVocabSource,
  removeFromVocabSource,
  addToPatternsSource,
  removeFromPatternsSource,
  addToCategoryMapSource,
} from './vocab-apply';

// Mini fixture mirroring the real schema.ts structure (categories + comments).
const SCHEMA_FIXTURE = `export const TOPIC_VOCAB = [
  // Tenses
  'presente',
  'passato-prossimo',
  // Verb classes
  'verbi-are',
  'verbi-ere',
  // Specific common verbs (worth tracking individually — they recur)
  'essere',
  'avere',
  // Articles, nouns, prepositions
  'articoli-determinati',
  // Pronouns
  'pronomi-diretti',
  // Adjectives
  'aggettivi',
  // Reading & pronunciation
  'pronuncia',
  // Set-phrase constructions
  'mi-piace',
  // Themes / vocabulary domains
  'famiglia',
] as const;
`;

const TOPICS_FIXTURE = `const PATTERNS: PatternMap = {
  // ─── Tenses ──────────────────────────────────────────────────────────────
  presente: [
    /\\bpresente\\b/i,
  ],
  'passato-prossimo': [
    /\\bpassato\\s+prossimo\\b/i,
  ],

  // ─── Verb classes ────────────────────────────────────────────────────────
  'verbi-are': [
    /verbi\\s+-are/i,
  ],

  // ─── Specific common verbs ───────────────────────────────────────────────
  essere: [
    /\\bessere\\b/i,
  ],

  // ─── Articles, nouns, prepositions ───────────────────────────────────────
  'articoli-determinati': [
    /articolo\\s+determinativo/i,
  ],

  // ─── Pronouns ────────────────────────────────────────────────────────────
  'pronomi-diretti': [
    /pronomi\\s+diretti/i,
  ],

  // ─── Adjectives ──────────────────────────────────────────────────────────
  aggettivi: [
    /\\baggettivi\\b/i,
  ],

  // ─── Reading & pronunciation ─────────────────────────────────────────────
  pronuncia: [
    /\\bpronuncia\\b/i,
  ],

  // ─── Set-phrase constructions ────────────────────────────────────────────
  'mi-piace': [
    /\\bmi\\s+piace\\b/i,
  ],

  // ─── Themes / vocabulary domains ─────────────────────────────────────────
  famiglia: [
    /\\bla\\s+famiglia\\b/i,
  ],
};

// Detect topics present in the given text. Returns topics in TOPIC_VOCAB order
// for determinism.
export function detectTopics(text: string): TopicT[] {
  return [];
}
`;

describe('addToVocabSource', () => {
  it('appends to end of Tenses section', () => {
    const out = addToVocabSource(SCHEMA_FIXTURE, 'trapassato-prossimo', 'Tenses');
    // New entry should appear between 'passato-prossimo' and '// Verb classes'.
    expect(out).toMatch(/'passato-prossimo',\n  'trapassato-prossimo',\n  \/\/ Verb classes/);
  });

  it('appends to last section (Themes) before `] as const;`', () => {
    const out = addToVocabSource(SCHEMA_FIXTURE, 'cucina', 'Themes / vocabulary domains');
    expect(out).toMatch(/'famiglia',\n  'cucina',\n\] as const;/);
  });

  it('is idempotent — no duplicates if topic already present', () => {
    const out = addToVocabSource(SCHEMA_FIXTURE, 'verbi-are', 'Verb classes');
    expect(out).toBe(SCHEMA_FIXTURE);
  });

  it('rejects invalid topic IDs', () => {
    expect(() => addToVocabSource(SCHEMA_FIXTURE, 'Bad-Id', 'Tenses')).toThrow(/kebab/);
    expect(() => addToVocabSource(SCHEMA_FIXTURE, 'has space', 'Tenses')).toThrow(/kebab/);
  });

  it('rejects unknown categories', () => {
    expect(() => addToVocabSource(SCHEMA_FIXTURE, 'foo', 'NotACategory')).toThrow(/Unknown category/);
  });

  it('throws clearly if section marker is missing', () => {
    const broken = SCHEMA_FIXTURE.replace('// Verb classes', '// VerbClasses');
    expect(() => addToVocabSource(broken, 'foo', 'Tenses')).toThrow(/Anchor.*not found/);
  });
});

describe('removeFromVocabSource', () => {
  it('removes existing topic and the line containing it', () => {
    const out = removeFromVocabSource(SCHEMA_FIXTURE, 'verbi-ere');
    expect(out).not.toMatch(/'verbi-ere',/);
    // Surrounding lines stay intact.
    expect(out).toMatch(/'verbi-are',\n  \/\/ Specific common verbs/);
  });

  it('throws if topic not in vocab', () => {
    expect(() => removeFromVocabSource(SCHEMA_FIXTURE, 'nonexistent')).toThrow(/not found/);
  });

  it('rejects invalid topic IDs', () => {
    expect(() => removeFromVocabSource(SCHEMA_FIXTURE, 'Bad-Id')).toThrow(/kebab/);
  });
});

describe('addToPatternsSource', () => {
  it('appends pattern block at end of Tenses section', () => {
    const out = addToPatternsSource(
      TOPICS_FIXTURE,
      'trapassato-prossimo',
      'Tenses',
      ['/\\btrapassato\\s+prossimo\\b/i', '/трапасато/i'],
    );
    expect(out).toContain(`'trapassato-prossimo': [
    /\\btrapassato\\s+prossimo\\b/i,
    /трапасато/i,
  ],`);
    // Inserted BEFORE the next section marker.
    expect(out).toMatch(/'trapassato-prossimo':\s*\[[\s\S]+?\],\n\s*\/\/ ─── Verb classes/);
  });

  it('inserts in Themes section before closing of PATTERNS', () => {
    const out = addToPatternsSource(
      TOPICS_FIXTURE,
      'cucina',
      'Themes / vocabulary domains',
      ['/\\bla\\s+cucina\\b/i'],
    );
    // cucina pattern is inserted before the closing '};\n\n// Detect topics' marker.
    expect(out).toMatch(/cucina:\s*\[[\s\S]+?\],\n\};/);
  });

  it('uses bare identifier when topic id is a valid JS identifier', () => {
    const out = addToPatternsSource(TOPICS_FIXTURE, 'trapassato', 'Tenses', ['/x/']);
    expect(out).toMatch(/^  trapassato:\s*\[/m);
  });

  it('quotes the key when topic id contains a hyphen', () => {
    const out = addToPatternsSource(TOPICS_FIXTURE, 'trapassato-prossimo', 'Tenses', ['/x/']);
    expect(out).toMatch(/^  'trapassato-prossimo':\s*\[/m);
  });

  it('is idempotent — no duplicate block if topic key already present', () => {
    const out = addToPatternsSource(TOPICS_FIXTURE, 'verbi-are', 'Verb classes', ['/whatever/']);
    expect(out).toBe(TOPICS_FIXTURE);
  });

  it('rejects empty regex list', () => {
    expect(() =>
      addToPatternsSource(TOPICS_FIXTURE, 'foo', 'Tenses', []),
    ).toThrow(/No regex/);
  });
});

describe('removeFromPatternsSource', () => {
  it('removes the entire pattern block (multi-line)', () => {
    const out = removeFromPatternsSource(TOPICS_FIXTURE, 'verbi-are');
    expect(out).not.toMatch(/verbi-are/);
    // Adjacent sections still well-formed.
    expect(out).toMatch(/\/\/ ─── Verb classes ───[\s\S]*?\/\/ ─── Specific common/);
  });

  it('removes block with bare-identifier key', () => {
    const out = removeFromPatternsSource(TOPICS_FIXTURE, 'essere');
    expect(out).not.toMatch(/^  essere:/m);
  });

  it('throws if pattern block not present', () => {
    expect(() => removeFromPatternsSource(TOPICS_FIXTURE, 'nonexistent-topic')).toThrow(/not found/);
  });
});

// Mini fixture mirroring scripts/lib/topic-to-category.ts (box-drawing
// section headers + the "// Compute the union" comment that follows the map).
const CATEGORY_MAP_FIXTURE = `export const TOPIC_TO_CATEGORIES: Record<TopicT, readonly CheatsheetCategoryId[]> = {
  // ── Tenses ────────────────────────────────────────────────────────────────
  presente: ['chasy'],
  // ── Verb classes ──────────────────────────────────────────────────────────
  'verbi-are': ['chasy', 'diieslova'],
  // ── Specific common verbs ─────────────────────────────────────────────────
  essere: ['diieslova', 'chasy'],
  // ── Articles, nouns, prepositions ─────────────────────────────────────────
  'articoli-determinati': ['artikli'],
  // ── Pronouns ──────────────────────────────────────────────────────────────
  'pronomi-diretti': ['konstruktsii'],
  // ── Adjectives ────────────────────────────────────────────────────────────
  aggettivi: ['imennyky'],
  // ── Reading & pronunciation ──────────────────────────────────────────────
  pronuncia: ['chytannia'],
  // ── Set-phrase constructions ─────────────────────────────────────────────
  'mi-piace': ['konstruktsii'],
  // ── Themes / vocabulary domains ──────────────────────────────────────────
  famiglia: [],
};

// Compute the union of cheat sheet categories that a lesson's topics affect.
`;

describe('addToCategoryMapSource', () => {
  it('appends to end of Tenses section with the section default', () => {
    const out = addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'trapassato', 'Tenses');
    expect(out).toContain(
      "  presente: ['chasy'],\n  trapassato: ['grammar'], // auto-added by vocab-review — confirm editorially\n  // ── Verb classes",
    );
  });

  it('appends themes with an empty list before the closing brace', () => {
    const out = addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'al-ristorante', 'Themes / vocabulary domains');
    expect(out).toContain("  famiglia: [],\n  'al-ristorante': ['vocabulary'], // auto-added");
    expect(out).toContain('};\n\n// Compute the union');
  });

  it('quotes hyphenated keys and leaves bare identifiers unquoted', () => {
    expect(addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'sapere-conoscere', 'Specific common verbs')).toContain(
      "  'sapere-conoscere': ['vocabulary'],",
    );
    expect(addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'volere', 'Specific common verbs')).toContain(
      "  volere: ['vocabulary'],",
    );
  });

  it('is idempotent — no duplicate entry if topic already mapped', () => {
    const out = addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'presente', 'Tenses');
    expect(out).toBe(CATEGORY_MAP_FIXTURE);
    const quoted = addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'verbi-are', 'Verb classes');
    expect(quoted).toBe(CATEGORY_MAP_FIXTURE);
  });

  it('rejects invalid topic IDs and unknown categories', () => {
    expect(() => addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'Bad_ID', 'Tenses')).toThrow(/kebab-case/);
    expect(() => addToCategoryMapSource(CATEGORY_MAP_FIXTURE, 'ok', 'Nope')).toThrow(/Unknown category/);
  });

  it('throws clearly if section marker is missing', () => {
    const broken = CATEGORY_MAP_FIXTURE.replace('  // ── Verb classes', '  // Verb classes');
    expect(() => addToCategoryMapSource(broken, 'trapassato', 'Tenses')).toThrow(/Anchor .* not found/);
  });

  it('every review category has a default that only uses known cheatsheet ids', async () => {
    const { DEFAULT_CATEGORIES_BY_SECTION, CATEGORY_MAP_NEXT_MARKER } = await import('./vocab-apply');
    const { CHEATSHEET_CATEGORY_IDS } = await import('./topic-to-category');
    const known = new Set<string>(CHEATSHEET_CATEGORY_IDS);
    expect(Object.keys(DEFAULT_CATEGORIES_BY_SECTION).sort()).toEqual(
      Object.keys(CATEGORY_MAP_NEXT_MARKER).sort(),
    );
    for (const cats of Object.values(DEFAULT_CATEGORIES_BY_SECTION)) {
      for (const c of cats) expect(known.has(c), c).toBe(true);
    }
  });

  it('anchors in CATEGORY_MAP_NEXT_MARKER exist in the real topic-to-category.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { CATEGORY_MAP_NEXT_MARKER } = await import('./vocab-apply');
    // Windows checkouts may be CRLF (git normalises on commit); the markers are LF.
    const real = readFileSync(new URL('./topic-to-category.ts', import.meta.url), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    for (const [section, marker] of Object.entries(CATEGORY_MAP_NEXT_MARKER)) {
      expect(real.includes(marker), `anchor for "${section}" missing: ${marker}`).toBe(true);
    }
  });
});

describe('round-trip — add then remove restores original', () => {
  it('vocab', () => {
    const added = addToVocabSource(SCHEMA_FIXTURE, 'trapassato-prossimo', 'Tenses');
    const removed = removeFromVocabSource(added, 'trapassato-prossimo');
    expect(removed).toBe(SCHEMA_FIXTURE);
  });

  it('patterns', () => {
    const added = addToPatternsSource(
      TOPICS_FIXTURE,
      'trapassato-prossimo',
      'Tenses',
      ['/\\btrapassato\\b/i', '/\\bтрапасато\\b/i'],
    );
    const removed = removeFromPatternsSource(added, 'trapassato-prossimo');
    expect(removed).toBe(TOPICS_FIXTURE);
  });
});
