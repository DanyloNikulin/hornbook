import { describe, it, expect } from 'vitest';
import { DEFAULT_TOPIC_CATALOG, type TopicCatalogT } from '../../src/lib/schema.ts';
import { compileCatalog, detectTopics } from './topics';

describe('detectTopics on the default catalogue', () => {
  it('returns empty array for unrelated text', () => {
    expect(detectTopics('hello world, this is unrelated', DEFAULT_TOPIC_CATALOG)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(detectTopics('', DEFAULT_TOPIC_CATALOG)).toEqual([]);
  });

  it('detects grammar', () => {
    expect(detectTopics('Today we study grammar and conjugation.', DEFAULT_TOPIC_CATALOG)).toContain('grammar');
  });

  it('detects vocabulary', () => {
    expect(detectTopics('New vocabulary: the word list for shops.', DEFAULT_TOPIC_CATALOG)).toContain('vocabulary');
  });

  it('detects pronunciation', () => {
    expect(detectTopics('Pronunciation of the letter r.', DEFAULT_TOPIC_CATALOG)).toContain('pronunciation');
  });

  it('is deterministic: catalogue order, not text order', () => {
    const a = detectTopics('grammar vocabulary', DEFAULT_TOPIC_CATALOG);
    const b = detectTopics('vocabulary grammar', DEFAULT_TOPIC_CATALOG);
    expect(a).toEqual(b);
    expect(a).toEqual(['grammar', 'vocabulary']);
  });
});

describe('a section catalogue', () => {
  const catalog: TopicCatalogT = {
    categories: [{ id: 'chasy', title: 'Часи' }],
    topics: [
      { id: 'presente', categories: ['chasy'], patterns: ['\\bpresent[eaoi]\\s+indicativo', 'теперішн'] },
      { id: 'broken', categories: [], patterns: ['('] },
      { id: 'passato-prossimo', categories: ['chasy'], patterns: ['\\bpassato\\s+prossimo\\b'] },
    ],
  };

  it('matches Latin and Cyrillic patterns case-insensitively', () => {
    expect(detectTopics('Il PRESENTE indicativo dei verbi', catalog)).toEqual(['presente']);
    expect(detectTopics('Сьогодні теперішній час', catalog)).toEqual(['presente']);
  });

  it('skips a pattern that does not compile and keeps the rest', () => {
    const compiled = compileCatalog(catalog);
    expect(compiled.find((c) => c.id === 'broken')?.regexes).toEqual([]);
    expect(detectTopics('passato prossimo', catalog)).toEqual(['passato-prossimo']);
  });
});
