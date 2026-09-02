import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheatsheetService } from './cheatsheet.service';
import { SearchService } from './search.service';
import { VocabService } from './vocab.service';

function stubFailedFetch(status = 503) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status } as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('lazy data services — failure semantics', () => {
  it('VocabService rejects and retries after an HTTP failure', async () => {
    const fetchMock = stubFailedFetch();
    const service = new VocabService();

    await expect(service.all()).rejects.toThrow('HTTP 503');
    await expect(service.all()).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('SearchService rejects and retries after an HTTP failure', async () => {
    const fetchMock = stubFailedFetch();
    const service = new SearchService();

    await expect(service.search('passato')).rejects.toThrow('HTTP 503');
    await expect(service.search('passato')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('CheatsheetService rejects and retries after an HTTP failure', async () => {
    const fetchMock = stubFailedFetch();
    const service = new CheatsheetService();

    await expect(service.get()).rejects.toThrow('HTTP 503');
    await expect(service.get()).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
