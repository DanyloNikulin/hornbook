import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchService, type SearchDoc } from './search.service';

function doc(text: string, section: SearchDoc['section'] = 'article', slug = 'l1'): SearchDoc {
  return { lesson_slug: slug, lesson_title: 'Lesson', lesson_date: '2026-09-01', section, text };
}

function stubIndex(docs: SearchDoc[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => docs,
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('SearchService — snippets', () => {
  it('returns short text untouched when the query matches', async () => {
    stubIndex([doc('Il passato prossimo si forma con avere o essere.')]);
    const [hit] = await new SearchService().search('passato prossimo');
    expect(hit?.snippet).toBe('Il passato prossimo si forma con avere o essere.');
  });

  it('windows around the match with ellipses and collapses whitespace', async () => {
    const filler = 'a'.repeat(120);
    const text = `${filler}   passato\n\nprossimo   ${'b'.repeat(200)}`;
    stubIndex([doc(text)]);
    const [hit] = await new SearchService().search('passato');
    expect(hit?.snippet.startsWith('…')).toBe(true);
    expect(hit?.snippet.endsWith('…')).toBe(true);
    expect(hit?.snippet).toContain('passato prossimo');
    expect(hit?.snippet).not.toMatch(/\s{2,}/);
    // 160-char window plus the two ellipses.
    expect(hit?.snippet.length).toBeLessThanOrEqual(162);
  });

  it('matches case-insensitively when locating the window', async () => {
    stubIndex([doc(`${'x'.repeat(100)} PASSATO ${'y'.repeat(100)}`)]);
    const [hit] = await new SearchService().search('passato');
    expect(hit?.snippet).toContain('PASSATO');
  });

  it('falls back to a truncated head when Fuse matched fuzzily but the literal query is absent', async () => {
    const text = `${'z'.repeat(200)} passatto`;
    stubIndex([doc(text)]);
    const hits = await new SearchService().search('passato');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toBe(text.slice(0, 160) + '…');
  });
});

describe('SearchService — lifecycle', () => {
  it('returns [] for a blank query without fetching', async () => {
    const fetchMock = stubIndex([]);
    expect(await new SearchService().search('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the index once and reuses it across searches', async () => {
    const fetchMock = stubIndex([doc('uno due tre'), doc('quattro cinque', 'vocab')]);
    const svc = new SearchService();
    await svc.search('uno');
    await svc.search('cinque');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the payload is not an array and retries on the next call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [doc('ciao')] } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const svc = new SearchService();
    await expect(svc.search('ciao')).rejects.toThrow('not an array');
    expect((await svc.search('ciao')).length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
