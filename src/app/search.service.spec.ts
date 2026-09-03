import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SearchService, type SearchDoc } from './search.service';
import { SectionService } from './section.service';

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

function service(): SearchService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: SectionService, useValue: { id: () => 'es-en' } }],
  });
  return TestBed.inject(SearchService);
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('SearchService — snippets', () => {
  it('returns short text untouched when the query matches', async () => {
    stubIndex([doc('Il passato prossimo si forma con avere o essere.')]);
    const [hit] = await service().search('passato prossimo');
    expect(hit?.snippet).toBe('Il passato prossimo si forma con avere o essere.');
  });

  it('windows around the match with ellipses and collapses whitespace', async () => {
    const filler = 'a'.repeat(120);
    const text = `${filler}   passato\n\nprossimo   ${'b'.repeat(200)}`;
    stubIndex([doc(text)]);
    const [hit] = await service().search('passato');
    expect(hit?.snippet.startsWith('…')).toBe(true);
    expect(hit?.snippet.endsWith('…')).toBe(true);
    expect(hit?.snippet).toContain('passato prossimo');
    expect(hit?.snippet).not.toMatch(/\s{2,}/);
    expect(hit?.snippet.length).toBeLessThanOrEqual(162);
  });

  it('matches case-insensitively when locating the window', async () => {
    stubIndex([doc(`${'x'.repeat(100)} PASSATO ${'y'.repeat(100)}`)]);
    const [hit] = await service().search('passato');
    expect(hit?.snippet).toContain('PASSATO');
  });

  it('falls back to a truncated head when Fuse matched fuzzily but the literal query is absent', async () => {
    const text = `${'z'.repeat(200)} passatto`;
    stubIndex([doc(text)]);
    const hits = await service().search('passato');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toBe(text.slice(0, 160) + '…');
  });
});

describe('SearchService — lifecycle', () => {
  it('returns [] for a blank query without fetching', async () => {
    const fetchMock = stubIndex([]);
    expect(await service().search('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the section index once and reuses it', async () => {
    const fetchMock = stubIndex([doc('hola amigo')]);
    const svc = service();
    await svc.search('hola');
    await svc.search('amigo');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sections/es-en/search-index');
  });

  it('rejects a non-array payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
    );
    await expect(service().search('x')).rejects.toThrow('not an array');
  });
});
