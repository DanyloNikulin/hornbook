import { describe, it, expect } from 'vitest';
import { DEFAULT_TOPIC_CATALOG, type TopicCatalogT } from '../../src/lib/schema.ts';
import { categoriesForTopics, categoryIds, categoryTitle, computeAffectedCategories } from './topic-to-category.ts';

const CATALOG: TopicCatalogT = {
  categories: [
    { id: 'chasy', title: 'Часи дієслова' },
    { id: 'diieslova', title: 'Дієслова' },
    { id: 'konstruktsii', title: 'Конструкції' },
  ],
  topics: [
    { id: 'stare-gerundio', categories: ['chasy', 'konstruktsii'], patterns: [] },
    { id: 'verbi-are', categories: ['chasy', 'diieslova'], patterns: [] },
    { id: 'famiglia', categories: [], patterns: [] },
  ],
};

describe('default catalogue', () => {
  it('maps every default topic onto the category of the same name', () => {
    for (const t of DEFAULT_TOPIC_CATALOG.topics) {
      expect(categoriesForTopics([t.id], DEFAULT_TOPIC_CATALOG)).toEqual([t.id]);
    }
  });

  it('only names known categories', () => {
    const known = new Set(categoryIds(DEFAULT_TOPIC_CATALOG));
    for (const t of DEFAULT_TOPIC_CATALOG.topics) {
      for (const c of t.categories) expect(known.has(c), `${t.id} → ${c}`).toBe(true);
    }
  });
});

describe('categoriesForTopics', () => {
  it('returns [] for no topics', () => {
    expect(categoriesForTopics([], CATALOG)).toEqual([]);
  });

  it('unions categories in catalogue order, once each', () => {
    expect(categoriesForTopics(['verbi-are', 'stare-gerundio', 'verbi-are'], CATALOG)).toEqual([
      'chasy',
      'diieslova',
      'konstruktsii',
    ]);
  });

  it('counts a theme without categories and an unknown topic for nothing', () => {
    expect(categoriesForTopics(['famiglia', 'not-in-catalogue'], CATALOG)).toEqual([]);
  });

  it('is what computeAffectedCategories does', () => {
    expect(computeAffectedCategories(['stare-gerundio'], CATALOG)).toEqual(['chasy', 'konstruktsii']);
  });
});

describe('categoryTitle', () => {
  it('returns the title, or the id when the category is unknown', () => {
    expect(categoryTitle(CATALOG, 'chasy')).toBe('Часи дієслова');
    expect(categoryTitle(CATALOG, 'grammar')).toBe('grammar');
  });
});
