import { describe, expect, it } from 'vitest';
import { Lesson } from '../../src/lib/schema';
import { aliasLessonFields, defaultCardType, mcAnswerIndex } from './lesson-input-aliases';

// The shape qwen2.5:7b produced for a Spanish greetings lesson (2026-09-03).
function qwenLesson(): Record<string, unknown> {
  return {
    id: '2026-09-03-saludos',
    date: '2026-09-03',
    slug: 'saludos',
    title: 'Saludos básicos',
    summary: 'Greetings.',
    article_md: '## Takeaway\nSay hello.',
    vocabulary: [],
    grammar: [],
    quotes: [],
    quiz: [
      {
        type: 'mc',
        question: '¿Cómo se dice "good morning"?',
        options: ['Buenas noches', 'Buenos días', 'Hasta luego'],
        answer: 'Buenos días',
      },
      { type: 'fill', question: 'Buenas ___ (evening)', answer: 'noches' },
      { question: 'Translate: see you later', answer: 'hasta luego' },
    ],
    flashcards: [
      { front: 'hola', back: 'hello' },
      { front: 'buenos días', back: 'good morning' },
      { front: 'ser vs estar', back: 'two verbs for "to be"', type: 'Grammar' },
    ],
    slides: [],
    related: [],
    topics: ['vocabulary'],
  };
}

describe('aliasLessonFields', () => {
  it('turns the qwen2.5:7b lesson into one Zod accepts', () => {
    const input = qwenLesson();
    expect(Lesson.safeParse(input).success).toBe(false);

    const messages = aliasLessonFields(input);

    const parsed = Lesson.safeParse(input);
    expect(parsed.success).toBe(true);
    const quiz = parsed.success ? parsed.data.quiz : [];
    expect(quiz[0]).toMatchObject({ type: 'mc', q: '¿Cómo se dice "good morning"?', answer: 1 });
    expect(quiz[1]).toMatchObject({ type: 'fill', q: 'Buenas ___ (evening)', answer: 'noches' });
    expect(quiz[2]).toMatchObject({ type: 'fill', q: 'Translate: see you later', answer: 'hasta luego' });
    const cards = parsed.success ? parsed.data.flashcards : [];
    expect(cards.map((c) => c.type)).toEqual(['word', 'phrase', 'grammar']);

    expect(messages).toEqual([
      "quiz[0]: 'question' → 'q'",
      'quiz[0]: answer "Buenos días" → index 1',
      "quiz[1]: 'question' → 'q'",
      "quiz[2]: 'question' → 'q'",
      "quiz[2]: type null → 'fill' (from its fields)",
      "flashcards[0]: type null → 'word' (from the front text)",
      "flashcards[1]: type null → 'phrase' (from the front text)",
      "flashcards[2]: type \"Grammar\" → 'grammar'",
    ]);
  });

  it('leaves a schema-shaped lesson untouched', () => {
    const input: Record<string, unknown> = {
      quiz: [
        { type: 'mc', q: 'Q?', options: ['a', 'b'], answer: 0 },
        { type: 'translate', q: 'hello', answer_target: 'hola' },
      ],
      flashcards: [{ front: 'hola', back: 'hello', type: 'word', tags: [] }],
    };
    const before = JSON.stringify(input);
    expect(aliasLessonFields(input)).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('moves a translate answer to answer_target and picks up correct_answer', () => {
    const input: Record<string, unknown> = {
      quiz: [
        { type: 'translate', q: 'hello', answer: 'hola' },
        { type: 'mc', q: 'Q?', options: ['x', 'y', 'z'], correct_answer: 'z' },
      ],
    };
    aliasLessonFields(input);
    expect(input['quiz']).toEqual([
      { type: 'translate', q: 'hello', answer_target: 'hola' },
      { type: 'mc', q: 'Q?', options: ['x', 'y', 'z'], answer: 2 },
    ]);
  });

  it('leaves an unmatched mc answer text for Zod to reject', () => {
    const input: Record<string, unknown> = {
      quiz: [{ type: 'mc', q: 'Q?', options: ['x', 'y'], answer: 'nope' }],
    };
    expect(aliasLessonFields(input)).toEqual([]);
    expect((input['quiz'] as { answer: unknown }[])[0]!.answer).toBe('nope');
  });

  it('ignores fields that are not arrays of objects', () => {
    const input: Record<string, unknown> = { quiz: 'text', flashcards: [1, null, 'x'] };
    expect(aliasLessonFields(input)).toEqual([]);
  });
});

describe('mcAnswerIndex', () => {
  const options = ['a', 'Buenos días', 'Hasta luego'];

  it('reads digits, option text and letter labels', () => {
    expect(mcAnswerIndex('2', options)).toBe(2);
    expect(mcAnswerIndex('  buenos días ', options)).toBe(1);
    expect(mcAnswerIndex('C', options)).toBe(2);
    expect(mcAnswerIndex('b)', options)).toBe(1);
  });

  it('prefers an option that is literally a letter over the label reading', () => {
    expect(mcAnswerIndex('a', options)).toBe(0);
    expect(mcAnswerIndex('a', ['de', 'a', 'en'])).toBe(1);
  });

  it('returns undefined when nothing matches', () => {
    expect(mcAnswerIndex('Z', options)).toBeUndefined();
    expect(mcAnswerIndex('something else', options)).toBeUndefined();
  });
});

describe('defaultCardType', () => {
  it('splits word and phrase on whitespace', () => {
    expect(defaultCardType('hola')).toBe('word');
    expect(defaultCardType('buenos días')).toBe('phrase');
    expect(defaultCardType(undefined)).toBe('word');
  });
});
