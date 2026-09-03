import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleExtractor } from './openai-extract.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubFetch(content: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('OpenAiCompatibleExtractor', () => {
  it('sends the schema with its description, and no images, to Ollama', async () => {
    vi.stubEnv('OLLAMA_HOST', 'http://box:11434/');
    const fetchMock = stubFetch('{"patches":[]}');

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
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://box:11434/v1/chat/completions');
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.model).toBe('qwen2.5:7b');
    expect(body.response_format.json_schema).toEqual({
      name: 'apply_cheatsheet_patches',
      description: 'Return deltas only.',
      strict: false,
      schema: { type: 'object' },
    });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('omits the description when the caller gives none', async () => {
    const fetchMock = stubFetch('{}');
    await new OpenAiCompatibleExtractor('ollama', 'llama3.1').extract({
      system: 's',
      userParts: [],
      jsonSchema: {},
      toolName: 'save_lesson',
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.response_format.json_schema).not.toHaveProperty('description');
  });

  it('refuses the openai driver without a key before touching the network', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchMock = stubFetch('{}');
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
