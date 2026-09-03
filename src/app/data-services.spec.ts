import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CheatsheetService } from './cheatsheet.service';
import { SearchService } from './search.service';
import { VocabService } from './vocab.service';
import { SectionService } from './section.service';

function stubFailedFetch(status = 503) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Service Unavailable',
    json: async () => ({ error: 'down' }),
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: SectionService, useValue: { id: () => 'es-en' } }],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('lazy data services — failure semantics', () => {
  it('VocabService rejects and retries after an HTTP failure', async () => {
    const fetchMock = stubFailedFetch();
    const service = TestBed.inject(VocabService);

    await expect(service.all()).rejects.toThrow('HTTP 503');
    await expect(service.all()).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sections/es-en/vocab');
  });

  it('SearchService rejects and retries after an HTTP failure', async () => {
    const fetchMock = stubFailedFetch();
    const service = TestBed.inject(SearchService);

    await expect(service.search('passato')).rejects.toThrow('HTTP 503');
    await expect(service.search('passato')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('CheatsheetService rejects and retries after an HTTP failure', async () => {
    const fetchMock = stubFailedFetch();
    const service = TestBed.inject(CheatsheetService);

    await expect(service.get()).rejects.toThrow('HTTP 503');
    await expect(service.get()).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
