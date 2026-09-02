import { describe, it, expect } from 'vitest';
import {
  CHEATSHEET_CATEGORY_IDS,
  TOPIC_TO_CATEGORIES,
  computeAffectedCategories,
  listMissingMappings,
} from './topic-to-category.ts';

describe('TOPIC_TO_CATEGORIES', () => {
  it('has an entry for every topic', () => {
    expect(listMissingMappings()).toEqual([]);
  });

  it('only maps to known category ids', () => {
    const known = new Set<string>(CHEATSHEET_CATEGORY_IDS);
    for (const [topic, cats] of Object.entries(TOPIC_TO_CATEGORIES)) {
      for (const c of cats) {
        expect(known.has(c), `topic "${topic}" maps to unknown "${c}"`).toBe(true);
      }
    }
  });

  it('maps grammar → grammar', () => {
    expect(TOPIC_TO_CATEGORIES.grammar).toEqual(['grammar']);
  });
});

describe('computeAffectedCategories', () => {
  it('returns empty array for no topics', () => {
    expect(computeAffectedCategories([])).toEqual([]);
  });

  it('unions unique categories', () => {
    expect(computeAffectedCategories(['grammar', 'vocabulary', 'grammar'])).toEqual([
      'grammar',
      'vocabulary',
    ]);
  });
});
