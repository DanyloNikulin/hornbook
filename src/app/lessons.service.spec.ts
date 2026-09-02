import { afterEach, describe, it, expect, vi } from 'vitest';
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

describe('LessonsService — load failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects HTTP failures and evicts them so a retry performs another fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const service = new LessonsService();
    const slug = service.allMeta()[0].slug;

    await expect(service.bySlug(slug)).rejects.toThrow('HTTP 503');
    await expect(service.bySlug(slug)).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still resolves unknown slugs as not found without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new LessonsService();

    await expect(service.bySlug('definitely-not-a-real-lesson')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
