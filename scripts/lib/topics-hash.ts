// Hash of a section's tagger configuration: topic ids and their patterns.
// backfill-topics --auto compares it with <section>/_topics-version.json to
// decide whether older lessons need re-tagging. Sorted by id, so reordering
// the catalogue is not a change; adding a topic or editing a pattern is.

import { createHash } from 'node:crypto';
import type { TopicCatalogT } from '../../src/lib/schema.ts';

export function computeTopicsHash(catalog: TopicCatalogT): string {
  const canonical = [...catalog.topics]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => `${t.id}\n${t.patterns.join('\n')}`)
    .join('\n---\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
