import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { Lesson } from '../src/lib/schema.ts';
import { buildSectionArchive, readSectionArchive } from './transfers.ts';

function sampleLesson(slug = 'greetings') {
  return Lesson.parse({
    id: 'ignored',
    date: '2026-09-04',
    slug,
    title: 'Greetings',
    summary: 'A small lesson.',
    article_md: '# Hello',
    vocabulary: [{ target: 'ciao', learner: 'hello' }],
    flashcards: [{ front: 'come stai?', back: 'how are you?', type: 'phrase' }],
  });
}

describe('section transfer archives', () => {
  it('round-trips pair content and never includes derived data', () => {
    const lesson = sampleLesson();
    const archive = buildSectionArchive({
      section: { id: 'it-en', target: 'it', learner: 'en', theme: { preset: 'sea', backdrop: '_backdrop.png' } },
      lessons: [lesson],
      cheatsheet: { processed_lessons: [lesson.slug], categories: [] },
      topics: { categories: [], topics: [] },
      progress: {
        sm2: {
          [`${lesson.vocabulary[0].id}:target-learner`]: {
            interval: 6,
            ef: 2.5,
            repetitions: 2,
            due: '2026-09-10',
          },
        },
        daily: null,
        quiz: {},
        activity: {},
      },
      backdrop: { name: '_backdrop.png', data: Uint8Array.from([137, 80, 78, 71]) },
    });

    const names = Object.keys(unzipSync(archive));
    expect(names).toContain('hornbook-section.json');
    expect(names).toContain(`lessons/${lesson.id}.json`);
    expect(names.some((name) => name.includes('_derived'))).toBe(false);

    const result = readSectionArchive(archive);
    expect(result.section).toMatchObject({ id: 'it-en', theme: { preset: 'sea' } });
    expect(result.lessons[0]).toEqual(lesson);
    expect(result.progress?.sm2).toHaveProperty(`${lesson.vocabulary[0].id}:target-learner`);
    expect([...result.backdrop!.data]).toEqual([137, 80, 78, 71]);
  });

  it('rejects an unsafe backdrop path before anything can be written', () => {
    const manifest = {
      format: 'hornbook-section',
      version: 1,
      exported_at: new Date().toISOString(),
      includes_progress: false,
      section: { id: 'it-en', target: 'it', learner: 'en', theme: { backdrop: '../outside.png' } },
    };
    const archive = zipSync({ 'hornbook-section.json': strToU8(JSON.stringify(manifest)) });
    expect(() => readSectionArchive(archive)).toThrow(/Unsafe archive file name/);
  });

  it('rejects a backdrop name that could overwrite section data', () => {
    const manifest = {
      format: 'hornbook-section',
      version: 1,
      exported_at: new Date().toISOString(),
      includes_progress: false,
      section: { id: 'it-en', target: 'it', learner: 'en', theme: { backdrop: '_progress.json' } },
    };
    const archive = zipSync({
      'hornbook-section.json': strToU8(JSON.stringify(manifest)),
      'backdrop/_progress.json': strToU8('{}'),
    });
    expect(() => readSectionArchive(archive)).toThrow(/Unsupported archive backdrop type/);
  });
});
