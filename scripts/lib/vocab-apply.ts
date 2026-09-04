// Pure edits of a section's topic catalogue, used by review-vocab to apply
// the additions a review proposes. Failure is loud: an unknown category or a
// pattern that does not compile throws instead of writing a half-usable file.

import type { TopicCatalogT, TopicEntryT } from '../../src/lib/schema.ts';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function hasTopic(catalog: TopicCatalogT, id: string): boolean {
  return catalog.topics.some((t) => t.id === id);
}

/** A model may answer with a regex literal (`/foo/i`); the catalogue stores the source. */
export function regexSource(pattern: string): string {
  const m = pattern.trim().match(/^\/(.+)\/[a-z]*$/s);
  return m ? m[1] : pattern.trim();
}

/** Append a topic. Same id already present: the catalogue is returned unchanged. */
export function addTopic(catalog: TopicCatalogT, entry: TopicEntryT): TopicCatalogT {
  if (!SLUG.test(entry.id)) throw new Error(`Invalid topic id (must be kebab-case): ${entry.id}`);
  const known = new Set(catalog.categories.map((c) => c.id));
  for (const c of entry.categories) {
    if (!known.has(c)) {
      throw new Error(
        `Unknown category "${c}" for topic ${entry.id}. Known: ${[...known].join(', ') || '(none)'}`,
      );
    }
  }
  const patterns = entry.patterns.map(regexSource).filter((p) => p.length > 0);
  for (const p of patterns) {
    try {
      new RegExp(p, 'i');
    } catch (err) {
      throw new Error(`Pattern for ${entry.id} does not compile: ${p} (${(err as Error).message})`);
    }
  }
  if (hasTopic(catalog, entry.id)) return catalog;
  return {
    ...catalog,
    topics: [...catalog.topics, { id: entry.id, categories: [...entry.categories], patterns }],
  };
}

export function removeTopic(catalog: TopicCatalogT, id: string): TopicCatalogT {
  if (!hasTopic(catalog, id)) throw new Error(`Topic "${id}" not found in the catalogue`);
  return { ...catalog, topics: catalog.topics.filter((t) => t.id !== id) };
}
