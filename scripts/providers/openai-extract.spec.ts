import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleExtractor } from './openai-extract.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Call = [string, RequestInit];

/** Answers /api/show with `capabilities` and the chat endpoint with `content`. */
function stubOllama(content: string, capabilities?: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) =>
    String(url).endsWith('/api/show')
      ? { ok: true, json: async () => (capabilities ? { capabilities } : {}) }
      : { ok: true, json: async () => ({ choices: [{ message: { content } }] }) },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function chatBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = (fetchMock.mock.calls as Call[]).find(([url]) => String(url).endsWith('/v1/chat/completions'));
  if (!call) throw new Error('no chat call');
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

describe('OpenAiCompatibleExtractor', () => {
  it('sends the schema with its description to Ollama, dropping images for a text-only model', async () => {
    vi.stubEnv('OLLAMA_HOST', 'http://box:11434/');
    const fetchMock = stubOllama('{"patches":[]}', ['completion', 'tools']);

    const result = await new OpenAiCompatibleExtractor('ollama', 'qwen2.5:7b').extract({
      system: 'sys',
      userParts: [
        { type: 'text', text: 'hi' },
        { type: 'image', imageJpeg: Buffer.from('jpeg') },
      ],
      jsonSchema: { type: 'object' },
      toolName: 'apply_cheatsheet_patches',
      toolDescription: 'Return deltas only.',
    });

    expect(result).toEqual({ patches: [] });
    const urls = (fetchMock.mock.calls as Call[]).map(([u]) => String(u));
    expect(urls).toContain('http://box:11434/v1/chat/completions');
    const body = chatBody(fetchMock) as { model: string; response_format: { json_schema: unknown }; messages: { role: string; content: unknown }[] };
    expect(body.model).toBe('qwen2.5:7b');
    expect(body.response_format.json_schema).toEqual({
      name: 'apply_cheatsheet_patches',
      description: 'Return deltas only.',
      strict: false,
      schema: { type: 'object' },
    });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]!.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('sends images to an Ollama model that reports vision, asking /api/show once', async () => {
    const fetchMock = stubOllama('{}', ['completion', 'vision']);
    const extractor = new OpenAiCompatibleExtractor('ollama', 'gemma3:4b');
    expect(await extractor.hasVision()).toBe(true);

    await extractor.extract({
      system: 's',
      userParts: [{ type: 'image', imageJpeg: Buffer.from('jpeg') }],
      jsonSchema: {},
      toolName: 'save_lesson',
    });

    const body = chatBody(fetchMock) as { messages: { content: { type: string }[] }[] };
    expect(body.messages[1]!.content[0]!.type).toBe('image_url');
    const shows = (fetchMock.mock.calls as Call[]).filter(([u]) => String(u).endsWith('/api/show'));
    expect(shows).toHaveLength(1);
  });

  it('treats an Ollama server that lists no capabilities as text-only', async () => {
    stubOllama('{}');
    expect(await new OpenAiCompatibleExtractor('ollama', 'llama3.1').hasVision()).toBe(false);
  });

  it('omits the description when the caller gives none', async () => {
    const fetchMock = stubOllama('{}');
    await new OpenAiCompatibleExtractor('ollama', 'llama3.1').extract({
      system: 's',
      userParts: [],
      jsonSchema: {},
      toolName: 'save_lesson',
    });
    const body = chatBody(fetchMock) as { response_format: { json_schema: object } };
    expect(body.response_format.json_schema).not.toHaveProperty('description');
  });

  it('treats openai as vision-capable without asking the network', async () => {
    const fetchMock = stubOllama('{}');
    expect(await new OpenAiCompatibleExtractor('openai', 'gpt-4o').hasVision()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the openai driver without a key before touching the network', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchMock = stubOllama('{}');
    await expect(
      new OpenAiCompatibleExtractor('openai', 'gpt-4o').extract({
        system: 's',
        userParts: [],
        jsonSchema: {},
        toolName: 't',
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
