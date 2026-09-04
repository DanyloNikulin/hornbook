import { describe, expect, it } from 'vitest';
import type { DerivedVocabT } from '../../lib/schema';
import { sortVocabEntries, vocabInitial } from './vocab.component';

const entry = (target: string, learner = target): DerivedVocabT => ({
  target,
  learner,
  level: null,
  first_seen: 'lesson-one',
  first_seen_date: '2026-09-04',
  seen_in: ['lesson-one'],
});

describe('glossary index helpers', () => {
  it('groups accented Latin words by their base letter and keeps other scripts in the fallback bucket', () => {
    expect(vocabInitial('È vero')).toBe('E');
    expect(vocabInitial('¿Dónde?')).toBe('D');
    expect(vocabInitial('こんにちは')).toBe('#');
  });

  it('sorts headwords naturally in either direction without mutating the source list', () => {
    const source = [entry('voce 10'), entry('Voce 2'), entry('àlbero')];
    expect(sortVocabEntries(source, 'az').map((item) => item.target)).toEqual(['àlbero', 'Voce 2', 'voce 10']);
    expect(sortVocabEntries(source, 'za').map((item) => item.target)).toEqual(['voce 10', 'Voce 2', 'àlbero']);
    expect(source.map((item) => item.target)).toEqual(['voce 10', 'Voce 2', 'àlbero']);
  });
});
