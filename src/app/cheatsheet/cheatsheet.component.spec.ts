import { describe, expect, it } from 'vitest';
import type { CheatsheetCategoryT } from '../../lib/schema';
import { cheatsheetAnchor, filterCheatsheetRail } from './cheatsheet.component';

const categories: CheatsheetCategoryT[] = [
  {
    id: 'tenses',
    title: 'Tenses',
    sections: [
      { id: 'present', title: 'Present tense', exception_tables: [], notes: [], source_lessons: [] },
      { id: 'past', title: 'Passato prossimo', exception_tables: [], notes: [], source_lessons: [] },
    ],
  },
  {
    id: 'verbs',
    title: 'Verbs',
    sections: [{ id: 'modal', title: 'Modal verbs', exception_tables: [], notes: [], source_lessons: [] }],
  },
];

describe('cheat sheet rail helpers', () => {
  it('builds category-scoped anchor ids', () => {
    expect(cheatsheetAnchor('tenses', 'present')).toBe('sheet-tenses-present');
  });

  it('filters section titles while preserving groups and includes a whole matching category', () => {
    expect(filterCheatsheetRail(categories, 'passato').map((category) => category.sections.map((section) => section.id))).toEqual([['past']]);
    expect(filterCheatsheetRail(categories, 'verbs').map((category) => category.sections.map((section) => section.id))).toEqual([['modal']]);
    expect(categories[0].sections).toHaveLength(2);
  });
});
