import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiExtractor } from './openai-extract.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Call = [string, RequestInit];

function stubOpenAi(content: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function chatCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const call = (fetchMock.mock.calls as Call[]).find(([url]) => String(url).endsWith('/v1/chat/completions'));
  if (!call) throw new Error('no chat call');
  return { url: String(call[0]), init: call[1], body: JSON.parse(String(call[1].body)) as Record<string, unknown> };
}

const REQ = { system: 'sys', userParts: [{ type: 'text' as const, text: 'hi' }], jsonSchema: { type: 'object' }, toolName: 'save_lesson' };

describe('OpenAiExtractor', () => {
  it('sends the schema with its description, the key, and the images', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = stubOpenAi('{"patches":[]}');

    const result = await new OpenAiExtractor('gpt-4o').extract({
      ...REQ,
      userParts: [
        { type: 'text', text: 'hi' },
        { type: 'image', imageJpeg: Buffer.from('jpeg') },
      ],
      toolName: 'apply_cheatsheet_patches',
      toolDescription: 'Return deltas only.',
    });

    expect(result).toEqual({ patches: [] });
    const { url, init, body } = chatCall(fetchMock);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
    expect(body['model']).toBe('gpt-4o');
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'apply_cheatsheet_patches', description: 'Return deltas only.', strict: false, schema: { type: 'object' } },
    });
    const messages = body['messages'] as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    const content = messages[1]!.content as { type: string }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url']);
  });

  it('omits the description when the caller gives none', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = stubOpenAi('{}');
    await new OpenAiExtractor('gpt-4o').extract(REQ);
    const { body } = chatCall(fetchMock);
    expect((body['response_format'] as { json_schema: object }).json_schema).not.toHaveProperty('description');
  });

  it('treats openai as vision-capable without asking the network', async () => {
    const fetchMock = stubOpenAi('{}');
    expect(await new OpenAiExtractor('gpt-4o').hasVision()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the openai driver without a key before touching the network', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchMock = stubOpenAi('{}');
    await expect(new OpenAiExtractor('gpt-4o').extract(REQ)).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries once when the request never reached HTTP, then reports the cause', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) throw dropped;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const extractor = new OpenAiExtractor('gpt-4o');
    extractor.retryPauseMs = 0;
    expect(await extractor.extract(REQ)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal('fetch', vi.fn(async () => { throw dropped; }));
    const again = new OpenAiExtractor('gpt-4o');
    again.retryPauseMs = 0;
    await expect(again.extract(REQ)).rejects.toThrow(/cannot reach .*ECONNRESET/);
  });
});
