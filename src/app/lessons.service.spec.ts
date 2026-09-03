import { afterEach, describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LessonsService, computeRelatedByTopicsMeta, filterMetasByTopic } from './lessons.service';
import type { LessonMetaT, TopicT } from '../lib/schema';

// Minimal fixtures — we exercise the pure helpers, not the full @Injectable
// (which would force us to mock the static JSON import). The algorithms only
// touch slug + topics; everything else is structural padding so the
// LessonMetaT type is satisfied without leaking irrelevant test setup.
function meta(slug: string, topics: readonly TopicT[]): LessonMetaT {
  return {
    slug,
    date: '2026-01-01',
    title: slug,
    summary: '',
    topics: [...topics],
    vocabCount: 0,
    grammarCount: 0,
    slidesCount: 0,
    quizCount: 0,
  };
}

describe('filterMetasByTopic', () => {
  const pool = [
    meta('a', ['grammar', 'vocabulary']),
    meta('b', ['pronunciation']),
    meta('c', ['grammar']),
  ];

  it('returns only metas containing the topic', () => {
    const result = filterMetasByTopic(pool, 'grammar');
    expect(result.map((l) => l.slug)).toEqual(['a', 'c']);
  });

  it('returns [] when no meta contains the topic', () => {
    const result = filterMetasByTopic(pool, 'reading');
    expect(result).toEqual([]);
  });

  it('preserves pool order', () => {
    // 'c' must follow 'a' in the result because 'a' is earlier in the pool,
    // even though both share the same single topic.
    const result = filterMetasByTopic(pool, 'grammar');
    expect(result[0].slug).toBe('a');
    expect(result[1].slug).toBe('c');
  });
});

describe('computeRelatedByTopicsMeta', () => {
  it('ranks by overlap count descending', () => {
    const current = meta('src', ['grammar', 'vocabulary', 'conversation']);
    const pool = [
      meta('one-overlap', ['grammar']),
      meta('three-overlap', ['grammar', 'vocabulary', 'conversation']),
      meta('two-overlap', ['grammar', 'vocabulary']),
    ];
    const result = computeRelatedByTopicsMeta(current, pool);
    expect(result.map((r) => r.meta.slug)).toEqual(['three-overlap', 'two-overlap', 'one-overlap']);
    expect(result.map((r) => r.sharedTopics.length)).toEqual([3, 2, 1]);
  });

  it('skips the source meta', () => {
    const current = meta('src', ['grammar']);
    const pool = [meta('src', ['grammar']), meta('other', ['grammar'])];
    const result = computeRelatedByTopicsMeta(current, pool);
    expect(result.map((r) => r.meta.slug)).toEqual(['other']);
  });

  it('drops metas with zero overlap', () => {
    const current = meta('src', ['grammar']);
    const pool = [meta('match', ['grammar', 'vocabulary']), meta('no-match', ['reading'])];
    const result = computeRelatedByTopicsMeta(current, pool);
    expect(result.map((r) => r.meta.slug)).toEqual(['match']);
  });

  it('drops metas with no topics at all', () => {
    const current = meta('src', ['grammar']);
    const pool = [meta('empty', [])];
    expect(computeRelatedByTopicsMeta(current, pool)).toEqual([]);
  });

  it('returns [] when the source has no topics', () => {
    const current = meta('src', []);
    const pool = [meta('other', ['grammar'])];
    expect(computeRelatedByTopicsMeta(current, pool)).toEqual([]);
  });

  it('caps results at the top-N limit', () => {
    const current = meta('src', ['grammar']);
    const pool = [
      meta('a', ['grammar']),
      meta('b', ['grammar']),
      meta('c', ['grammar']),
      meta('d', ['grammar']),
      meta('e', ['grammar']),
      meta('f', ['grammar']),
      meta('g', ['grammar']),
    ];
    const result = computeRelatedByTopicsMeta(current, pool, 3);
    expect(result).toHaveLength(3);
  });

  it('preserves candidate topic order in sharedTopics (not source order)', () => {
    // Candidate has topics in [vocabulary, grammar] order; source has them in
    // [grammar, vocabulary]. The candidate's order is what shows in the badge.
    const current = meta('src', ['grammar', 'vocabulary']);
    const pool = [meta('cand', ['vocabulary', 'grammar'])];
    const result = computeRelatedByTopicsMeta(current, pool);
    expect(result[0].sharedTopics).toEqual(['vocabulary', 'grammar']);
  });

  it('uses pool order as a stable tie-breaker', () => {
    // Three candidates all share 1 topic; result must keep pool order.
    const current = meta('src', ['grammar']);
    const pool = [
      meta('first', ['grammar']),
      meta('second', ['grammar']),
      meta('third', ['grammar']),
    ];
    const result = computeRelatedByTopicsMeta(current, pool);
    expect(result.map((r) => r.meta.slug)).toEqual(['first', 'second', 'third']);
  });
});

describe('LessonsService — load and fetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  function service(): LessonsService {
    TestBed.resetTestingModule();
    const svc = TestBed.inject(LessonsService);
    svc.sectionId.set('es-en');
    svc.metas.set([meta('greetings', ['grammar'])]);
    return svc;
  }

  it('rejects HTTP failures and evicts them so a retry performs another fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'down' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const svc = service();

    await expect(svc.bySlug('greetings')).rejects.toThrow('HTTP 503');
    await expect(svc.bySlug('greetings')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sections/es-en/lessons/greetings');
  });

  it('still resolves unknown slugs as not found without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = service();

    await expect(svc.bySlug('definitely-not-a-real-lesson')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('load() fills the manifest for a section and records failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        // The fixture's empty summary fails the schema, like `{ bad }` — both
        // must be skipped, not crash the load. 'a' carries a valid summary.
        json: async () => [{ ...meta('a', []), summary: 'A lesson.' }, meta('bad-summary', []), { bad: true }],
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'x', json: async () => ({ error: 'boom' }) } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
    const svc = TestBed.inject(LessonsService);

    await svc.load('es-en');
    expect(svc.allMeta().map((m) => m.slug)).toEqual(['a']);
    expect(svc.loadError()).toBeNull();

    await svc.load('it-en');
    expect(svc.allMeta()).toEqual([]);
    expect(svc.loadError()).toContain('500');
  });
});
