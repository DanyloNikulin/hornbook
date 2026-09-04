import { describe, expect, it } from 'vitest';
import { Lesson } from '../../src/lib/schema.ts';
import { buildDerived } from './derived.ts';

function lesson(slug: string, date: string) {
  return Lesson.parse({
    id: `${date}-${slug}`,
    date,
    slug,
    title: slug,
    summary: 'A lesson.',
    article_md: '# Lesson',
    vocabulary: [{ target: 'hola', learner: 'hello', level: 'A1' }],
  });
}

describe('derived study cards', () => {
  it('keeps repeated vocabulary as one card pair with all source lessons', () => {
    const bundle = buildDerived([lesson('first', '2026-01-01'), lesson('second', '2026-02-01')], 'es');

    expect(bundle.cards).toHaveLength(2);
    expect(bundle.cards.map((card) => card.lessons)).toEqual([
      ['first', 'second'],
      ['first', 'second'],
    ]);
    expect(bundle.cards.map((card) => card.id)).toEqual([
      '2026-01-01-first:vocab:001:target-learner',
      '2026-01-01-first:vocab:001:learner-target',
    ]);
    expect(bundle.cards.map((card) => card.source_ids)).toEqual([
      [
        '2026-01-01-first:vocab:001:target-learner',
        '2026-02-01-second:vocab:001:target-learner',
      ],
      [
        '2026-01-01-first:vocab:001:learner-target',
        '2026-02-01-second:vocab:001:learner-target',
      ],
    ]);
  });
});
