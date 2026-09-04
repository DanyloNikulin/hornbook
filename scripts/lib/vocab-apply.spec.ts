import { describe, it, expect } from 'vitest';
import { DEFAULT_TOPIC_CATALOG, type TopicCatalogT } from '../../src/lib/schema.ts';
import { addTopic, hasTopic, regexSource, removeTopic } from './vocab-apply';

const CATALOG: TopicCatalogT = {
  categories: [
    { id: 'chasy', title: 'Часи дієслова' },
    { id: 'konstruktsii', title: 'Конструкції' },
  ],
  topics: [
    { id: 'presente', categories: ['chasy'], patterns: ['\\bpresente\\b'] },
    { id: 'mi-piace', categories: ['konstruktsii'], patterns: ['\\bmi\\s+piace\\b'] },
  ],
};

describe('regexSource', () => {
  it('strips the slashes and flags of a regex literal', () => {
    expect(regexSource('/\\btrapassato\\b/i')).toBe('\\btrapassato\\b');
    expect(regexSource('/a\\/b/')).toBe('a\\/b');
  });

  it('leaves a bare source alone', () => {
    expect(regexSource('  трапасато ')).toBe('трапасато');
  });
});

describe('addTopic', () => {
  it('appends the topic with its categories and pattern sources', () => {
    const out = addTopic(CATALOG, {
      id: 'trapassato-prossimo',
      categories: ['chasy'],
      patterns: ['/\\btrapassato\\s+prossimo\\b/i', 'трапасато'],
    });
    expect(out.topics.map((t) => t.id)).toEqual(['presente', 'mi-piace', 'trapassato-prossimo']);
    expect(out.topics[2]).toEqual({
      id: 'trapassato-prossimo',
      categories: ['chasy'],
      patterns: ['\\btrapassato\\s+prossimo\\b', 'трапасато'],
    });
  });

  it('does not mutate the input', () => {
    addTopic(CATALOG, { id: 'futuro', categories: [], patterns: [] });
    expect(CATALOG.topics).toHaveLength(2);
  });

  it('is idempotent for an id already present', () => {
    expect(addTopic(CATALOG, { id: 'presente', categories: ['chasy'], patterns: ['x'] })).toBe(CATALOG);
  });

  it('rejects an id that is not kebab-case', () => {
    expect(() => addTopic(CATALOG, { id: 'Bad-Id', categories: [], patterns: [] })).toThrow(/kebab/);
    expect(() => addTopic(CATALOG, { id: 'has space', categories: [], patterns: [] })).toThrow(/kebab/);
  });

  it('rejects an unknown category', () => {
    expect(() => addTopic(CATALOG, { id: 'futuro', categories: ['grammar'], patterns: [] })).toThrow(
      /Unknown category "grammar"/,
    );
  });

  it('rejects a pattern that does not compile', () => {
    expect(() => addTopic(CATALOG, { id: 'futuro', categories: [], patterns: ['('] })).toThrow(
      /does not compile/,
    );
  });

  it('works on the default catalogue', () => {
    const out = addTopic(DEFAULT_TOPIC_CATALOG, { id: 'subjunctive', categories: ['grammar'], patterns: [] });
    expect(hasTopic(out, 'subjunctive')).toBe(true);
    expect(hasTopic(DEFAULT_TOPIC_CATALOG, 'subjunctive')).toBe(false);
  });
});

describe('removeTopic', () => {
  it('removes the topic and keeps the rest in order', () => {
    const out = removeTopic(CATALOG, 'presente');
    expect(out.topics.map((t) => t.id)).toEqual(['mi-piace']);
  });

  it('throws when the topic is not in the catalogue', () => {
    expect(() => removeTopic(CATALOG, 'nonexistent')).toThrow(/not found/);
  });

  it('round-trips with addTopic', () => {
    const added = addTopic(CATALOG, { id: 'futuro', categories: ['chasy'], patterns: ['\\bfuturo\\b'] });
    expect(removeTopic(added, 'futuro')).toEqual(CATALOG);
  });
});
