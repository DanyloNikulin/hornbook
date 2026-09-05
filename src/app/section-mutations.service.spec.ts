import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Lesson } from '../lib/schema';
import { ApiService } from './api.service';
import { SectionService } from './section.service';
import { JournalService } from './journal.service';
import { LessonsService } from './lessons.service';
import { CardsService } from './cards.service';
import { VocabService } from './vocab.service';
import { SearchService } from './search.service';
import { SectionMutations } from './section-mutations.service';
import { JobsService } from './jobs.service';

let id: string;
let word: string;
let get: ReturnType<typeof vi.fn>;
let post: ReturnType<typeof vi.fn>;
const lesson = () =>
  Lesson.parse({
    id: '2026-01-01-shared',
    date: '2026-01-01',
    slug: 'shared',
    title: word,
    summary: word,
    article_md: word,
  });
beforeEach(() => {
  id = 'es-en';
  word = 'orbit';
  localStorage.clear();
  get = vi.fn(async (path: string) => {
    if (path.endsWith('/lessons'))
      return [
        {
          slug: 'shared',
          title: word,
          summary: word,
          date: '2026-01-01',
          topics: [],
          vocabCount: 1,
          grammarCount: 0,
          slidesCount: 0,
          quizCount: 0,
        },
      ];
    if (path.endsWith('/lessons/shared')) return lesson();
    if (path.endsWith('/cards'))
      return [
        {
          id: 'c1',
          source_ids: ['c1'],
          front: word,
          back: word,
          direction: 'target-learner',
          source: 'vocab',
          type: 'word',
          tags: [],
          lessons: ['shared'],
          expected: word,
        },
      ];
    if (path.endsWith('/vocab'))
      return [
        {
          id: 'v1',
          source_ids: ['v1'],
          target: word,
          learner: word,
          level: null,
          first_seen: 'shared',
          first_seen_date: '2026-01-01',
          seen_in: ['shared'],
        },
      ];
    if (path.endsWith('/search-index'))
      return [
        {
          lesson_slug: 'shared',
          lesson_title: word,
          lesson_date: '2026-01-01',
          section: 'article',
          text: word,
        },
      ];
    throw new Error(path);
  });
  post = vi.fn(async () => {
    word = 'mountain';
    return { section: { id: 'es-en' }, lesson: lesson() };
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: { get, post } },
      { provide: SectionService, useValue: { id: () => id, apiBase: () => `/api/sections/${id}` } },
      { provide: JournalService, useValue: { refresh: vi.fn().mockResolvedValue(undefined) } },
    ],
  });
});
afterEach(() => TestBed.resetTestingModule());

it('refreshes saved content when a successful job has a cleanup warning', async () => {
  const lessons = TestBed.inject(LessonsService);
  await lessons.load('es-en');
  expect((await lessons.bySlug('shared'))?.title).toBe('orbit');
  vi.spyOn(TestBed.inject(JobsService), 'run').mockImplementation(async () => {
    word = 'mountain';
    return { id: 'job', section: 'es-en', kind: 'process', status: 'done', label: 'Saved', log: '', createdAt: '', result: { slug: 'shared' }, cleanup: { status: 'failed', error: 'Upload cleanup failed' } };
  });
  const job = await TestBed.inject(SectionMutations).runJob('es-en', { kind: 'process', filename: 'saved.json', base64: 'e30=', date: '2099-01-01' });
  expect(job.status).toBe('done');
  expect((await lessons.bySlug('shared'))?.title).toBe('mountain');
});

it('pair import invalidates cached lesson details, cards, vocabulary and search for the destination', async () => {
  const lessons = TestBed.inject(LessonsService);
  const cards = TestBed.inject(CardsService);
  const vocab = TestBed.inject(VocabService);
  const search = TestBed.inject(SearchService);
  await lessons.load(id);
  expect((await lessons.bySlug('shared'))?.title).toBe('orbit');
  expect((await cards.all())[0].front).toBe('orbit');
  expect((await vocab.all())[0].target).toBe('orbit');
  expect((await search.search('orbit'))[0].doc.text).toBe('orbit');
  await TestBed.inject(SectionMutations).importSection(
    new File(['fixture'], 'pair.zip'),
    'replace',
  );
  expect((await lessons.bySlug('shared'))?.title).toBe('mountain');
  expect((await cards.all())[0].front).toBe('mountain');
  expect((await vocab.all())[0].target).toBe('mountain');
  expect((await search.search('mountain'))[0].doc.text).toBe('mountain');
});

it('a section change during file reading keeps the import and cache refresh bound to its original destination', async () => {
  let finish!: (text: string) => void;
  const file = {
    text: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  } as File;
  const lessons = TestBed.inject(LessonsService);
  await lessons.load('es-en');
  const mutation = TestBed.inject(SectionMutations).importLesson('es-en', file, 'replace');
  id = 'it-en';
  await lessons.load(id);
  const before = lessons.metas();
  finish(JSON.stringify(lesson()));
  await mutation;
  expect(post.mock.calls[0][0]).toBe('/api/sections/es-en/lessons/import');
  expect(lessons.sectionId()).toBe('it-en');
  expect(lessons.metas()).toBe(before);
});

it('a rejected old request cannot evict a newer cached result after invalidation', async () => {
  let reject!: (error: Error) => void;
  get.mockReturnValueOnce(
    new Promise((_resolve, no) => {
      reject = no;
    }),
  );
  const vocab = TestBed.inject(VocabService);
  const old = vocab.all().catch(() => undefined);
  vocab.invalidate('es-en');
  const current = await vocab.all();
  reject(new Error('old failure'));
  await old;
  expect(await vocab.all()).toBe(current);
  expect(get).toHaveBeenCalledTimes(2);
});
