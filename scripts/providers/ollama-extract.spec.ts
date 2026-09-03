import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NUM_CTX, OllamaExtractor, ollamaNumCtx } from './ollama-extract.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Call = [string, RequestInit];

interface ChatBody {
  model: string;
  stream: boolean;
  format: unknown;
  options: { temperature: number; num_ctx: number };
  messages: { role: string; content: string; images?: string[] }[];
}

/** Answers /api/show with `capabilities` and /api/chat with `reply`. */
function stubOllama(reply: Record<string, unknown>, capabilities?: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
    String(url).endsWith('/api/show')
      ? { ok: true, json: async () => (capabilities ? { capabilities } : {}) }
      : { ok: true, json: async () => reply },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function chatCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; body: ChatBody } {
  const call = (fetchMock.mock.calls as Call[]).find(([url]) => String(url).endsWith('/api/chat'));
  if (!call) throw new Error('no chat call');
  return { url: String(call[0]), body: JSON.parse(String(call[1].body)) as ChatBody };
}

const REQ = {
  system: 'sys',
  userParts: [
    { type: 'text' as const, text: 'hi' },
    { type: 'image' as const, imageJpeg: Buffer.from('jpeg') },
  ],
  jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  toolName: 'save_lesson',
};

describe('OllamaExtractor', () => {
  it('calls the native chat API with the schema as format, a large context, and images for a vision model', async () => {
    vi.stubEnv('OLLAMA_HOST', 'http://box:11434/');
    const fetchMock = stubOllama({ message: { content: '{"ok":true}' } }, ['completion', 'vision']);

    const result = await new OllamaExtractor('gemma3:4b').extract({ ...REQ, toolDescription: 'Save the lesson once.' });

    expect(result).toEqual({ ok: true });
    const { url, body } = chatCall(fetchMock);
    expect(url).toBe('http://box:11434/api/chat');
    expect(body.model).toBe('gemma3:4b');
    expect(body.stream).toBe(false);
    expect(body.format).toEqual(REQ.jsonSchema);
    expect(body.options).toEqual({ temperature: 0, num_ctx: DEFAULT_NUM_CTX });
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toContain('sys');
    expect(body.messages[0]!.content).toContain('save_lesson: Save the lesson once.');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi', images: [Buffer.from('jpeg').toString('base64')] });
    expect((fetchMock.mock.calls as Call[]).filter(([u]) => String(u).endsWith('/api/show'))).toHaveLength(1);
  });

  it('sends text only to a model without vision, with no images field at all', async () => {
    const fetchMock = stubOllama({ message: { content: '{}' } }, ['completion', 'tools']);
    await new OllamaExtractor('qwen2.5:7b').extract(REQ);
    const { body } = chatCall(fetchMock);
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(body.messages[0]!.content).toBe('sys');
  });

  it('treats an Ollama server that lists no capabilities as text-only', async () => {
    stubOllama({ message: { content: '{}' } });
    expect(await new OllamaExtractor('llama3.1').hasVision()).toBe(false);
  });

  it('lets OLLAMA_NUM_CTX raise or lower the context', async () => {
    expect(ollamaNumCtx({})).toBe(DEFAULT_NUM_CTX);
    expect(ollamaNumCtx({ OLLAMA_NUM_CTX: '32768' })).toBe(32768);
    expect(ollamaNumCtx({ OLLAMA_NUM_CTX: 'lots' })).toBe(DEFAULT_NUM_CTX);
    vi.stubEnv('OLLAMA_NUM_CTX', '8192');
    const fetchMock = stubOllama({ message: { content: '{}' } }, ['completion']);
    await new OllamaExtractor('qwen2.5:7b').extract(REQ);
    expect(chatCall(fetchMock).body.options.num_ctx).toBe(8192);
  });

  it('explains an answer that came back cut off, with the token counts', async () => {
    stubOllama(
      { message: { content: '{"title": "Saludos", "summary": "cut' }, done_reason: 'length', prompt_eval_count: 3000, eval_count: 1090 },
      ['completion', 'vision'],
    );
    await expect(new OllamaExtractor('gemma3:4b').extract(REQ)).rejects.toThrow(/prompt 3000 \+ answer 1090 tokens .*OLLAMA_NUM_CTX/);
  });

  it('reports an HTTP error with Ollama’s message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, _init?: RequestInit) =>
        String(url).endsWith('/api/show')
          ? { ok: true, json: async () => ({}) }
          : { ok: false, status: 404, text: async () => '{"error":"model \'nope\' not found"}' },
      ),
    );
    await expect(new OllamaExtractor('nope').extract(REQ)).rejects.toThrow(/HTTP 404.*not found/);
  });

  it('retries once when the request never reached HTTP, then reports the cause', async () => {
    const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).endsWith('/api/show')) return { ok: true, json: async () => ({ capabilities: ['completion'] }) };
      if ((fetchMock.mock.calls as Call[]).filter(([u]) => String(u).endsWith('/api/chat')).length === 1) throw dropped;
      return { ok: true, json: async () => ({ message: { content: '{"ok":true}' } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const extractor = new OllamaExtractor('qwen2.5:7b');
    extractor.retryPauseMs = 0;
    expect(await extractor.extract(REQ)).toEqual({ ok: true });
    expect((fetchMock.mock.calls as Call[]).filter(([u]) => String(u).endsWith('/api/chat'))).toHaveLength(2);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, _init?: RequestInit) => {
        if (String(url).endsWith('/api/show')) return { ok: true, json: async () => ({}) };
        throw dropped;
      }),
    );
    const again = new OllamaExtractor('qwen2.5:7b');
    again.retryPauseMs = 0;
    await expect(again.extract(REQ)).rejects.toThrow(/cannot reach .*ECONNRESET/);
  });
});
