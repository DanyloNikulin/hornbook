import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractValidated, formatIssues, repairMessage } from './extract-validate';
import { Lesson } from '../../src/lib/schema';
import type { ExtractRequest, Extractor } from '../providers/types';

const VALID = {
  id: '2026-09-03-saludos',
  date: '2026-09-03',
  slug: 'saludos',
  title: 'Saludos',
  summary: 'Greetings.',
  article_md: '## Takeaway\nSay hello.',
  vocabulary: [],
  grammar: [],
  quotes: [],
  quiz: [],
  flashcards: [],
  slides: [],
  related: [],
  topics: ['vocabulary'],
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

  it('treats a non-object answer as an empty lesson rather than crashing', async () => {
    await expect(extractValidated(fakeExtractor(['nope', null]), REQUEST, logs, quiet)).rejects.toThrow(
      /repair round/,
    );
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
