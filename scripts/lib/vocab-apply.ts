// Programmatic source-file edits for applying vocab-review proposals to
// src/lib/schema.ts and scripts/lib/topics.ts.
//
// Strategy: anchor-based insertion using the category comment markers that
// already exist in those files. Failure is loud — if a marker is missing or
// shifted, throw rather than silently produce broken source.
//
// Limitations:
//   - Only additions and removals are auto-applied. Splits and merges remain
//     markdown-only proposals (the user has to manually re-categorize
//     existing lessons, which the regex can't do alone).
//   - If you reorder TOPIC_VOCAB sections or rename category comments, these
//     anchors break. The mapping below must stay in sync with schema.ts.

// Maps a Claude-returned `category` enum to the marker that immediately
// follows that category's section in src/lib/schema.ts. Insertions are made
// directly above this marker, which appends to the end of the section.
export const SCHEMA_CATEGORY_NEXT_MARKER: Record<string, string> = {
  Tenses: '  // Verb classes',
  'Verb classes': '  // Specific common verbs',
  'Specific common verbs': '  // Articles, nouns, prepositions',
  'Articles, nouns, prepositions': '  // Pronouns',
  Pronouns: '  // Adjectives',
  Adjectives: '  // Reading & pronunciation',
  'Reading & pronunciation': '  // Set-phrase constructions',
  'Set-phrase constructions': '  // Themes / vocabulary domains',
  'Themes / vocabulary domains': '] as const;',
};

// Same mapping for the PATTERNS map in scripts/lib/topics.ts. Marker text
// differs because that file uses box-drawing section headers.
export const TOPICS_CATEGORY_NEXT_MARKER: Record<string, string> = {
  Tenses: '  // ─── Verb classes',
  'Verb classes': '  // ─── Specific common verbs',
  'Specific common verbs': '  // ─── Articles, nouns, prepositions',
  'Articles, nouns, prepositions': '  // ─── Pronouns',
  Pronouns: '  // ─── Adjectives',
  Adjectives: '  // ─── Reading & pronunciation',
  'Reading & pronunciation': '  // ─── Set-phrase constructions',
  'Set-phrase constructions': '  // ─── Themes / vocabulary domains',
  'Themes / vocabulary domains': '};\n\n// Detect topics',
};

// Same mapping for TOPIC_TO_CATEGORIES in scripts/lib/topic-to-category.ts.
// That map is typed Record<TopicT, …>, so a topic added to TOPIC_VOCAB
// without an entry here breaks `npm run typecheck:scripts` and
// build-cheatsheet's runtime guard. vocab-review therefore appends a stub
// entry with a conservative default derived from the review category; the
// trailing comment marks it for editorial review.
export const CATEGORY_MAP_NEXT_MARKER: Record<string, string> = {
  Tenses: '  // ── Verb classes',
  'Verb classes': '  // ── Specific common verbs',
  'Specific common verbs': '  // ── Articles, nouns, prepositions',
  'Articles, nouns, prepositions': '  // ── Pronouns',
  Pronouns: '  // ── Adjectives',
  Adjectives: '  // ── Reading & pronunciation',
  'Reading & pronunciation': '  // ── Set-phrase constructions',
  'Set-phrase constructions': '  // ── Themes / vocabulary domains',
  'Themes / vocabulary domains': '};\n\n// Compute the union',
};

// Default cheat-sheet categories per review category. Deliberately narrow:
// a wider default only makes build-cheatsheet send more categories to Claude
// per lesson. Themes carry vocabulary, not rules, so they map to nothing.
export const DEFAULT_CATEGORIES_BY_SECTION: Record<string, readonly string[]> = {
  Tenses: ['grammar'],
  'Verb classes': ['grammar'],
  'Specific common verbs': ['vocabulary'],
  'Articles, nouns, prepositions': ['grammar'],
  Pronouns: ['grammar'],
  Adjectives: ['grammar'],
  'Reading & pronunciation': ['pronunciation'],
  'Set-phrase constructions': ['conversation'],
  'Themes / vocabulary domains': ['vocabulary'],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Topic-id syntax matches the SlugRegex used by Zod.
function assertValidTopicId(id: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`Invalid topic ID (must be kebab-case): ${id}`);
  }
}

function assertCategory(category: string, map: Record<string, string>): void {
  if (!(category in map)) {
    throw new Error(
      `Unknown category: ${JSON.stringify(category)}. Expected one of: ${Object.keys(map).join(', ')}`,
    );
  }
}

// ── schema.ts: TOPIC_VOCAB ──────────────────────────────────────────────────

export function addToVocabSource(source: string, id: string, category: string): string {
  assertValidTopicId(id);
  assertCategory(category, SCHEMA_CATEGORY_NEXT_MARKER);

  // Idempotency: silently no-op if already present.
  if (new RegExp(`^  '${escapeRegex(id)}',\\s*$`, 'm').test(source)) {
    return source;
  }

  const nextMarker = SCHEMA_CATEGORY_NEXT_MARKER[category];
  const idx = source.indexOf(nextMarker);
  if (idx === -1) {
    throw new Error(
      `Anchor "${nextMarker}" not found in schema.ts. Did the section comments change?`,
    );
  }
  return source.slice(0, idx) + `  '${id}',\n` + source.slice(idx);
}

export function removeFromVocabSource(source: string, id: string): string {
  assertValidTopicId(id);
  // Matches: `  'topic-id',` on its own line (with trailing newline).
  const re = new RegExp(`^  '${escapeRegex(id)}',\\s*$\\n`, 'm');
  const result = source.replace(re, '');
  if (result === source) {
    throw new Error(`Topic "${id}" not found in TOPIC_VOCAB`);
  }
  return result;
}

// ── topics.ts: PATTERNS map ─────────────────────────────────────────────────

// Render the pattern block exactly as it should appear in source, e.g.:
//   '<id>': [
//     /\bregex\b/i,
//     /more/i,
//   ],
function renderPatternBlock(id: string, regexes: readonly string[]): string {
  const needsQuotes = !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(id);
  const key = needsQuotes ? `'${id}'` : id;
  const body = regexes.map((re) => `    ${re},`).join('\n');
  return `  ${key}: [\n${body}\n  ],\n`;
}

export function addToPatternsSource(
  source: string,
  id: string,
  category: string,
  regexes: readonly string[],
): string {
  assertValidTopicId(id);
  assertCategory(category, TOPICS_CATEGORY_NEXT_MARKER);
  if (regexes.length === 0) {
    throw new Error(`No regex patterns provided for topic ${id}`);
  }

  // Idempotency: skip if topic key already present in PATTERNS.
  if (new RegExp(`^  '?${escapeRegex(id)}'?\\s*:\\s*\\[`, 'm').test(source)) {
    return source;
  }

  const nextMarker = TOPICS_CATEGORY_NEXT_MARKER[category];
  const idx = source.indexOf(nextMarker);
  if (idx === -1) {
    throw new Error(
      `Anchor "${nextMarker}" not found in topics.ts. Did the section headers change?`,
    );
  }
  return source.slice(0, idx) + renderPatternBlock(id, regexes) + source.slice(idx);
}

// ── topic-to-category.ts: TOPIC_TO_CATEGORIES map ──────────────────────────

export function addToCategoryMapSource(source: string, id: string, category: string): string {
  assertValidTopicId(id);
  assertCategory(category, CATEGORY_MAP_NEXT_MARKER);

  // Idempotency: skip if the topic already has an entry.
  if (new RegExp(`^  '?${escapeRegex(id)}'?\\s*:\\s*\\[`, 'm').test(source)) {
    return source;
  }

  const nextMarker = CATEGORY_MAP_NEXT_MARKER[category];
  const idx = source.indexOf(nextMarker);
  if (idx === -1) {
    throw new Error(
      `Anchor "${nextMarker}" not found in topic-to-category.ts. Did the section headers change?`,
    );
  }
  const needsQuotes = !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(id);
  const key = needsQuotes ? `'${id}'` : id;
  const cats = DEFAULT_CATEGORIES_BY_SECTION[category].map((c) => `'${c}'`).join(', ');
  const line = `  ${key}: [${cats}], // auto-added by vocab-review — confirm editorially\n`;
  return source.slice(0, idx) + line + source.slice(idx);
}

export function removeFromPatternsSource(source: string, id: string): string {
  assertValidTopicId(id);
  // Matches a complete pattern block from "  'id': [" (or "  id: [" if the
  // key doesn't need quoting) to the closing "  ],". Multi-line, lazy.
  const re = new RegExp(
    `^  '?${escapeRegex(id)}'?\\s*:\\s*\\[[\\s\\S]*?^  \\],\\s*$\\n`,
    'm',
  );
  const result = source.replace(re, '');
  if (result === source) {
    throw new Error(`Pattern block for "${id}" not found in topics.ts`);
  }
  return result;
}
