import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { invalidateConfig, setJournalDir, useSection } from './journal.ts';
import { buildLessonTool, buildSystemPrompt, userMessageForLesson } from './prompt.ts';
import { DEFAULT_TOPIC_CATALOG } from '../../src/lib/schema.ts';

beforeEach(() => {
  setJournalDir(join(process.cwd(), 'journal'));
  invalidateConfig();
  useSection('es-en');
});

afterEach(() => {
  invalidateConfig();
});

describe('buildSystemPrompt — free local models', () => {
  it('names the open pair so qwen2.5:7b writes in the right languages', () => {
    const prompt = buildSystemPrompt(DEFAULT_TOPIC_CATALOG);
    expect(prompt).toContain('Spanish');
    expect(prompt).toContain('English');
  });

  it('keeps filler greetings only when they are the lesson', () => {
    const prompt = buildSystemPrompt(DEFAULT_TOPIC_CATALOG);
    expect(prompt).toMatch(/SKIP filler greetings \(hola, ciao, hi\)/);
    expect(prompt).toMatch(/If greetings ARE the lesson, keep the words that were taught/);
  });

  it('tells the model to copy quotes from the transcript or omit them', () => {
    const prompt = buildSystemPrompt(DEFAULT_TOPIC_CATALOG);
    expect(prompt).toMatch(/quotes:.*that appear in the transcript/s);
    expect(prompt).toMatch(/never empty, never just a speaker label/);
    expect(prompt).toMatch(/Omit quotes rather than inventing them/);
  });
});

describe('buildLessonTool', () => {
  it('spells out quote fields so Ollama structured output cannot skip them', () => {
    const tool = buildLessonTool(DEFAULT_TOPIC_CATALOG);
    expect(tool.name).toBe('save_lesson');
    const quotes = (tool.input_schema as { properties: { quotes: { items: { required: string[] } } } })
      .properties.quotes.items;
    expect(quotes.required).toEqual(['speaker', 'text', 'ts']);
  });

  it('requires example sentences on every vocabulary entry', () => {
    const tool = buildLessonTool(DEFAULT_TOPIC_CATALOG);
    const vocab = (
      tool.input_schema as {
        properties: { vocabulary: { items: { required: string[] } } };
      }
    ).properties.vocabulary.items;
    expect(vocab.required).toEqual(['target', 'learner', 'example_target', 'example_learner']);
  });
});

describe('userMessageForLesson', () => {
  it('puts the transcript last so a small context still sees the words', () => {
    const text = userMessageForLesson({
      transcript: 'Hola. Today we study Spanish greetings.',
      dateHint: '2026-09-03',
      framesManifest: [],
      existingLessons: [],
      preliminaryTopics: ['vocabulary'],
    });
    expect(text).toContain('TARGET LANGUAGE: Spanish');
    expect(text).toContain('LEARNER LANGUAGE: English');
    expect(text.endsWith('TRANSCRIPT:\nHola. Today we study Spanish greetings.')).toBe(true);
  });
});
