// Regex topic tagger over a section's catalogue (<section>/_topics.json).
// Each topic's `patterns` are regex sources, compiled case-insensitively; a
// source that does not compile is skipped. This is a hint for hand-written
// or imported lessons (`npm run backfill-topics`); the extraction model tags
// lessons itself from the same catalogue.

import type { TopicCatalogT, TopicT } from '../../src/lib/schema.ts';

export interface CompiledTopic {
  id: TopicT;
  regexes: RegExp[];
}

export function compileCatalog(catalog: TopicCatalogT): CompiledTopic[] {
  return catalog.topics.map((t) => ({
    id: t.id,
    regexes: t.patterns.flatMap((source) => {
      try {
        return [new RegExp(source, 'i')];
      } catch {
        return [];
      }
    }),
  }));
}

/** Topics whose patterns match the text, in catalogue order. */
export function detectTopics(text: string, catalog: TopicCatalogT): TopicT[] {
  const found: TopicT[] = [];
  for (const { id, regexes } of compileCatalog(catalog)) {
    if (regexes.some((re) => re.test(text))) found.push(id);
  }
  return found;
}

export function formatTopics(topics: readonly TopicT[]): string {
  return topics.length === 0 ? '(none)' : topics.join(', ');
}
