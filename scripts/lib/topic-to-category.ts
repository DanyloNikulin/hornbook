// Which cheat-sheet categories a lesson's topics can change, read from the
// section's topic catalogue (<section>/_topics.json).

import type { TopicCatalogT, TopicT } from '../../src/lib/schema.ts';

export type CheatsheetCategoryId = string;

export function categoryIds(catalog: TopicCatalogT): CheatsheetCategoryId[] {
  return catalog.categories.map((c) => c.id);
}

export function categoryTitle(catalog: TopicCatalogT, id: string): string {
  return catalog.categories.find((c) => c.id === id)?.title ?? id;
}

/**
 * Union of the categories the topics name, in catalogue order. A topic the
 * catalogue does not know counts for nothing.
 */
export function categoriesForTopics(
  topics: readonly TopicT[],
  catalog: TopicCatalogT,
): CheatsheetCategoryId[] {
  const wanted = new Set<string>();
  for (const t of topics) {
    for (const c of catalog.topics.find((x) => x.id === t)?.categories ?? []) wanted.add(c);
  }
  return categoryIds(catalog).filter((id) => wanted.has(id));
}

export const computeAffectedCategories = categoriesForTopics;
