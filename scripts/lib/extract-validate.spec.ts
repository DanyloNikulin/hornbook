import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractValidated, formatIssues, hollowIssues, repairMessage } from './extract-validate';
import { Lesson } from '../../src/lib/schema';
import type { ExtractRequest, Extractor } from '../providers/types';

/** Schema-valid but with nothing to study from: only the article is filled. */
const HOLLOW = {
  id: '2026-09-03-saludos',
  date: '2026-09-03',
  slug: 'saludos',
  title: 'Saludos',
  summary: 'Greetings.',
  article_md: '## Takeaway\nSay hello.\n\n| hola | hello |',
  vocabulary: [],
  grammar: [],
  quotes: [],
  quiz: [],
  flashcards: [],
  slides: [],
  related: [],
  topics: ['vocabulary'],
};

const VALID = {
  ...HOLLOW,
  vocabulary: [{ target: 'hola', learner: 'hello', level: 'A1', example_target: 'Hola, Ana.', example_learner: 'Hello, Ana.' }],
  quiz: [{ type: 'fill', q: 'Say hello in Spanish.', answer: 'hola' }],
  flashcards: [{ front: 'hola', back: 'hello', type: 'word', tags: ['A1'] }],
};

const REQUEST: ExtractRequest = {
  system: 'sys',
  userParts: [{ type: 'text', text: 'transcript' }],
  jsonSchema: {},
  toolName: 'save_lesson',
};

const quiet = { warn: () => undefined, log: () => undefined };

/** Answers each call with the next canned response and records the requests. */
function fakeExtractor(responses: unknown[]): Extractor & { requests: ExtractRequest[] } {
  const requests: ExtractRequest[] = [];
  return {
    driver: 'fake',
    requests,
    hasVision: () => Promise.resolve(false),
    async extract(req) {
      requests.push(req);
      const next = responses.shift();
      if (next === undefined) throw new Error('no more canned responses');
      return next;
    },
  };
}

let logs: string;
beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), 'hornbook-validate-'));
});
afterEach(() => rmSync(logs, { recursive: true, force: true }));

describe('extractValidated', () => {
  it('accepts a valid first answer without a repair round', async () => {
    const extractor = fakeExtractor([VALID]);
    const out = await extractValidated(extractor, REQUEST, logs, quiet);
    expect(out.attempts).toBe(1);
    expect(out.lesson.slug).toBe('saludos');
    expect(extractor.requests).toHaveLength(1);
    expect(existsSync(join(logs, 'tool-input.json'))).toBe(true);
    expect(existsSync(join(logs, 'validation-errors.json'))).toBe(false);
  });

  it('runs the aliases before judging, so a drifted lesson needs no round trip', async () => {
    const drifted = { ...VALID, quiz: [{ type: 'mc', question: 'Q?', options: ['a', 'b'], answer: 'b' }] };
    const out = await extractValidated(fakeExtractor([drifted]), REQUEST, logs, quiet);
    expect(out.attempts).toBe(1);
    expect(out.lesson.quiz[0]).toMatchObject({ q: 'Q?', answer: 1 });
  });

  it('sends the issues and the previous output back once and accepts the repair', async () => {
    const broken = { ...VALID, quiz: [{ type: 'mc', q: 'Which greeting fits the morning?' }] };
    const extractor = fakeExtractor([broken, VALID]);
    const out = await extractValidated(extractor, REQUEST, logs, quiet);

    expect(out.attempts).toBe(2);
    expect(Lesson.safeParse(out.lesson).success).toBe(true);
    expect(extractor.requests).toHaveLength(2);
    const parts = extractor.requests[1]!.userParts;
    expect(parts[0]).toEqual(REQUEST.userParts[0]);
    const repair = parts[1]!.text ?? '';
    expect(repair).toContain('quiz.0.options');
    expect(repair).toContain('quiz.0.answer');
    expect(repair).toContain('Which greeting fits the morning?');
    for (const f of ['tool-input.json', 'validation-errors.json', 'tool-input-2.json']) {
      expect(existsSync(join(logs, f)), f).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(logs, 'tool-input-2.json'), 'utf8')).slug).toBe('saludos');
  });

  it('gives up after the second failure and keeps both error files', async () => {
    const broken = { ...VALID, title: '' };
    await expect(extractValidated(fakeExtractor([broken, broken]), REQUEST, logs, quiet)).rejects.toThrow(
      /after a repair round/,
    );
    expect(existsSync(join(logs, 'validation-errors.json'))).toBe(true);
    expect(existsSync(join(logs, 'validation-errors-2.json'))).toBe(true);
  });

  it('asks once for the structured fields when a valid answer is hollow, and accepts the filled one', async () => {
    const extractor = fakeExtractor([HOLLOW, VALID]);
    const out = await extractValidated(extractor, REQUEST, logs, quiet);
    expect(out.attempts).toBe(2);
    expect(out.lesson.vocabulary).toHaveLength(1);
    const repair = extractor.requests[1]!.userParts[1]!.text ?? '';
    expect(repair).toContain('vocabulary: empty');
    expect(repair).toContain('quiz: empty');
    expect(repair).toContain('| hola | hello |');
    expect(JSON.parse(readFileSync(join(logs, 'validation-errors.json'), 'utf8')).hollow).toHaveLength(4);
  });

  it('keeps a hollow lesson that stays hollow after the repair round, with a warning', async () => {
    const warnings: string[] = [];
    const out = await extractValidated(fakeExtractor([HOLLOW, HOLLOW]), REQUEST, logs, {
      warn: (m: string) => warnings.push(m),
      log: () => undefined,
    });
    expect(out.attempts).toBe(2);
    expect(out.lesson.vocabulary).toHaveLength(0);
    expect(warnings.join('\n')).toMatch(/still has no vocabulary or quiz/);
  });

  it('treats a non-object answer as an empty lesson rather than crashing', async () => {
    await expect(extractValidated(fakeExtractor(['nope', null]), REQUEST, logs, quiet)).rejects.toThrow(
      /repair round/,
    );
  });

  it('salvages a qwen2.5:7b German-shaped answer in one pass, no repair round', async () => {
    const qwen = {
      ...VALID,
      title: 'Grüße und Begrüßungen',
      summary: 'German greetings.',
      vocabulary: [],
      quotes: [
        { speaker: 'teacher', text: 'Teacher', ts: '00:01' },
        {
          speaker: 'teacher',
          text: "Don't be afraid, don't be confused and don't get into the details.",
          ts: '08:30',
        },
        { speaker: 'teacher', text: 'Guten Tag', ts: '00:00' },
      ],
      flashcards: [
        { front: 'Guten Tag', back: 'Good day', type: 'word', tags: [] },
        { front: 'Hallo', back: 'Hello', type: 'word', tags: [] },
      ],
    };
    const request = {
      ...REQUEST,
      userParts: [{ type: 'text' as const, text: 'Guten Tag. Hallo. Today we study German greetings.' }],
    };
    const extractor = fakeExtractor([qwen]);
    const out = await extractValidated(extractor, request, logs, quiet);

    expect(out.attempts).toBe(1);
    expect(extractor.requests).toHaveLength(1);
    expect(out.lesson.vocabulary.map((v) => v.target)).toEqual(['Guten Tag', 'Hallo']);
    expect(out.lesson.quotes).toEqual([{ speaker: 'teacher', text: 'Guten Tag', ts: '00:00' }]);
  });
});

describe('hollowIssues', () => {
  it('is quiet when either vocabulary or quiz has content', () => {
    const parsed = Lesson.parse(VALID);
    expect(hollowIssues(parsed)).toEqual([]);
    expect(hollowIssues(Lesson.parse({ ...HOLLOW, quiz: VALID.quiz }))).toEqual([]);
    expect(hollowIssues(Lesson.parse(HOLLOW)).map((i) => i.split(':')[0])).toEqual(['vocabulary', 'quiz', 'flashcards', 'grammar']);
  });
});

describe('repair message', () => {
  it('lists issues by path and quotes the previous output', () => {
    const parsed = Lesson.safeParse({ ...VALID, quiz: [{ type: 'fill', q: 'x' }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = formatIssues(parsed.error);
    expect(issues).toEqual(['quiz.0.answer: Invalid input: expected string, received undefined']);
    const msg = repairMessage({ slug: 'saludos' }, issues);
    expect(msg).toContain('- quiz.0.answer');
    expect(msg).toContain('{"slug":"saludos"}');
  });
});
