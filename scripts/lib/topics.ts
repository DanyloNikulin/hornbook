import { TOPIC_VOCAB, type TopicT } from '../../src/lib/schema.ts';

type PatternMap = Record<TopicT, RegExp[]>;

// Regex hints used by `npm run backfill-topics` to tag lessons that were
// written by hand or imported without topics. Keywords are English plus
// Ukrainian/Russian learner-side terms inherited from the original journal;
// add your own learner language here, or rely on the extraction model,
// which tags lessons directly and does not use this file.
//
// The `// ───` section comments are INSERTION ANCHORS for vocab-review
// (scripts/lib/vocab-apply.ts) and mirror the sections in src/lib/schema.ts.
// Keep their text and order exactly as-is.
const PATTERNS: PatternMap = {
  // ─── Tenses
  grammar: [/\bgrammar\b/i, /граматик/i, /грамматик/i, /\bconjugat/i, /\bdeclens/i],
  // ─── Verb classes
  vocabulary: [/\bvocabular/i, /\blexicon\b/i, /словник/i, /лексик/i, /\bword list\b/i],
  // ─── Specific common verbs
  conversation: [/\bdialog/i, /\bconversation\b/i, /діалог/i, /разговор/i, /\brole.?play\b/i],
  // ─── Articles, nouns, prepositions
  reading: [/\breading\b/i, /\btext\b/i, /читанн/i, /чтение/i],
  // ─── Pronouns
  listening: [/\blisten/i, /аудіюван/i, /аудирован/i, /\baudio\b/i],
  // ─── Adjectives
  // ─── Reading & pronunciation
  pronunciation: [/\bpronunc/i, /\bphonetic/i, /вимов/i, /произнош/i, /\bstress\b/i, /\baccent\b/i],
  // ─── Set-phrase constructions
  // ─── Themes / vocabulary domains
};

// Detect topics from raw transcript or article text.
export function detectTopics(text: string): TopicT[] {
  const found: TopicT[] = [];
  for (const id of TOPIC_VOCAB) {
    if (PATTERNS[id].some((re) => re.test(text))) found.push(id);
  }
  return found;
}

export function formatTopics(topics: readonly TopicT[]): string {
  return topics.length === 0 ? '(none)' : topics.join(', ');
}
