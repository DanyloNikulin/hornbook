import { describe, expect, it } from 'vitest';
import { Lesson } from '../../src/lib/schema';
import {
  foldForMatch,
  isJunkQuoteText,
  quoteAppearsInTranscript,
  salvageLessonFields,
  transcriptFromUserMessage,
} from './lesson-quality';

/**
 * Shape qwen2.5:7b produced for the 10-minute German A1 video
 * (whisper-cli + ggml-small, 2026-09-03): quiz and cards are usable,
 * vocabulary is empty, quotes are a speaker label plus an invented English
 * line that also landed on a slide.
 */
function qwenGerman(): Record<string, unknown> {
  return {
    id: '2026-09-04-greetings-2',
    date: '2026-09-04',
    slug: 'greetings-2',
    title: 'Grüße und Begrüßungen',
    summary: 'German greetings.',
    article_md: '## Takeaway\nGreetings.\n\n## Quotes\n- **text:** ',
    vocabulary: [],
    grammar: [],
    quotes: [
      { speaker: 'teacher', text: 'Teacher', ts: '00:01' },
      {
        speaker: 'teacher',
        text: "Don't be afraid, don't be confused and don't get into the details.",
        ts: '08:30',
      },
      { speaker: 'teacher', text: 'Guten Tag', ts: '00:00' },
    ],
    quiz: [{ type: 'fill', q: 'Fill in: _Tag is formal.', answer: 'Guten' }],
    flashcards: [
      { front: 'Guten Tag', back: 'Good day', type: 'word', tags: [] },
      { front: 'Hallo', back: 'Hello', type: 'word', tags: [] },
      { front: 'Guten Tag', back: 'Guten Morgen, Guten Abend', type: 'phrase', tags: [] },
      { front: 'formal vs informal', back: 'Sie vs du', type: 'grammar', tags: [] },
    ],
    slides: [],
    related: [],
    topics: ['vocabulary'],
  };
}

const GERMAN_TRANSCRIPT = [
  '[00:00] teacher: Guten Tag. Today we study German greetings.',
  '[00:05] teacher: Hallo means hello. You can use it any time of day.',
].join('\n');

describe('isJunkQuoteText', () => {
  it.each(['', '  ', 'Teacher', 'teacher:', '[teacher]', '**Teacher:**', '**text:**', 'Student'])(
    'rejects %j',
    (text) => {
      expect(isJunkQuoteText(text)).toBe(true);
    },
  );

  it('keeps a real teacher line, even if it starts with a name later', () => {
    expect(isJunkQuoteText('Guten Tag')).toBe(false);
    expect(isJunkQuoteText('Teacher: Guten Tag')).toBe(false);
  });
});

describe('quoteAppearsInTranscript', () => {
  it('matches ignoring case, punctuation and combining marks', () => {
    expect(quoteAppearsInTranscript('Guten Tag', GERMAN_TRANSCRIPT)).toBe(true);
    expect(quoteAppearsInTranscript('guten tag.', GERMAN_TRANSCRIPT)).toBe(true);
    expect(quoteAppearsInTranscript('Hallo means hello', GERMAN_TRANSCRIPT)).toBe(true);
  });

  it('rejects an invented English line from the German run', () => {
    expect(
      quoteAppearsInTranscript(
        "Don't be afraid, don't be confused and don't get into the details.",
        GERMAN_TRANSCRIPT,
      ),
    ).toBe(false);
  });

  it('matches a teacher line stitched across two timestamped utterances', () => {
    expect(
      quoteAppearsInTranscript(
        'Guten Tag. Today we study German greetings. Hallo means hello.',
        GERMAN_TRANSCRIPT,
      ),
    ).toBe(true);
  });
});

describe('foldForMatch', () => {
  it('strips German umlauts so Grüß matches Gruss', () => {
    expect(foldForMatch('Grüß Gott')).toBe(foldForMatch('Gruss Gott'));
  });
});

describe('transcriptFromUserMessage', () => {
  it('keeps only the recording, not titles or earlier lesson summaries', () => {
    const user = [
      'DATE_HINT: 2026-09-03',
      'TARGET LANGUAGE: German',
      'EXISTING LESSONS:',
      '- greetings (2026-01-01) Don\'t be afraid — a previous note',
      '',
      'TRANSCRIPT:',
      'Guten Tag. Today we study German greetings.',
    ].join('\n');
    const body = transcriptFromUserMessage(user);
    expect(body).toContain('Guten Tag');
    expect(body).not.toContain('Don\'t be afraid');
    expect(quoteAppearsInTranscript("Don't be afraid", body)).toBe(false);
    expect(quoteAppearsInTranscript('Guten Tag', body)).toBe(true);
  });
});

describe('salvageLessonFields', () => {
  it('turns the qwen2.5:7b German lesson into one the app can study from', () => {
    const input = qwenGerman();
    const before = Lesson.safeParse(input);
    expect(before.success).toBe(true);
    expect(before.success && before.data.vocabulary).toEqual([]);

    const messages = salvageLessonFields(input, GERMAN_TRANSCRIPT);

    const parsed = Lesson.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.vocabulary.map((v) => v.target)).toEqual(['Guten Tag', 'Hallo']);
    expect(parsed.data.vocabulary[0]).toMatchObject({
      learner: 'Good day',
      example_target: 'Guten Tag',
      example_learner: 'Good day',
    });
    expect(parsed.data.quotes).toEqual([{ speaker: 'teacher', text: 'Guten Tag', ts: '00:00' }]);
    expect(messages.some((m) => m.startsWith('vocabulary: 2 entries'))).toBe(true);
    expect(messages.some((m) => m.includes('speaker-label'))).toBe(true);
    expect(messages.some((m) => m.includes('invented'))).toBe(true);
  });

  it('leaves a lesson with vocabulary and on-transcript quotes untouched', () => {
    const input: Record<string, unknown> = {
      vocabulary: [{ target: 'hola', learner: 'hello' }],
      quotes: [{ speaker: 'teacher', text: 'Hola means hello', ts: '00:05' }],
      flashcards: [{ front: 'adiós', back: 'goodbye', type: 'word' }],
    };
    const before = JSON.stringify(input);
    expect(salvageLessonFields(input, 'Hola means hello. You can use it any time.')).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('does not invent vocabulary when flashcards are missing', () => {
    const input: Record<string, unknown> = { vocabulary: [], quotes: [] };
    expect(salvageLessonFields(input, 'anything')).toEqual([]);
    expect(input['vocabulary']).toEqual([]);
  });

  it('skips the invented-quote filter when there is no transcript yet', () => {
    const input: Record<string, unknown> = {
      quotes: [{ speaker: 'teacher', text: 'A line the file never had', ts: '01:00' }],
    };
    expect(salvageLessonFields(input, '  ')).toEqual([]);
    expect(input['quotes']).toHaveLength(1);
  });

  it('leaves quotes empty when every line is a label or invented, and the lesson still parses', () => {
    const input = {
      ...qwenGerman(),
      quotes: [
        { speaker: 'teacher', text: 'Teacher', ts: '00:01' },
        { speaker: 'teacher', text: 'Invented English that was never said', ts: '00:02' },
      ],
    };
    salvageLessonFields(input, GERMAN_TRANSCRIPT);
    expect(input['quotes']).toEqual([]);
    expect(Lesson.safeParse(input).success).toBe(true);
  });
});
