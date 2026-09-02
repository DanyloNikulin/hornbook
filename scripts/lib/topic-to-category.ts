import { TOPIC_VOCAB, type TopicT } from '../../src/lib/schema.ts';

export const CHEATSHEET_CATEGORY_IDS = [
  'grammar',
  'vocabulary',
  'pronunciation',
  'conversation',
  'reading',
  'listening',
] as const;

export type CheatsheetCategoryId = (typeof CHEATSHEET_CATEGORY_IDS)[number];

export const TOPIC_TO_CATEGORIES: Record<TopicT, readonly CheatsheetCategoryId[]> = {
  // ── Tenses
  grammar: ['grammar'],
  // ── Verb classes
  vocabulary: ['vocabulary'],
  // ── Specific common verbs
  conversation: ['conversation'],
  // ── Articles, nouns, prepositions
  reading: ['reading'],
  // ── Pronouns
  listening: ['listening'],
  // ── Adjectives
  // ── Reading & pronunciation
  pronunciation: ['pronunciation'],
  // ── Set-phrase constructions
  // ── Themes / vocabulary domains
};

// Compute the union of cheat sheet categories that a lesson's topics affect.

export function categoriesForTopics(topics: readonly TopicT[]): CheatsheetCategoryId[] {
  const set = new Set<CheatsheetCategoryId>();
  for (const t of topics) {
    for (const c of TOPIC_TO_CATEGORIES[t] ?? []) set.add(c);
  }
  return [...set];
}

export function computeAffectedCategories(topics: readonly TopicT[]): CheatsheetCategoryId[] {
  return categoriesForTopics(topics);
}

export function listMissingMappings(): TopicT[] {
  return TOPIC_VOCAB.filter((t) => TOPIC_TO_CATEGORIES[t] === undefined);
}
