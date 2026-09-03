import type { ExtractRequest, Extractor } from './types.ts';

/**
 * OpenAI Chat Completions and Ollama's OpenAI-compatible /v1/chat/completions.
 * Images are sent only when the driver is openai (Ollama vision is optional and
 * often missing — callers already skip frames when supportsVision is false).
 */
export class OpenAiCompatibleExtractor implements Extractor {
  readonly driver: 'openai' | 'ollama';
  readonly supportsVision: boolean;

  constructor(
    driver: 'openai' | 'ollama',
    private readonly model: string,
  ) {
    this.driver = driver;
    this.supportsVision = driver === 'openai';
  }

  async extract(req: ExtractRequest): Promise<unknown> {
    const { url, headers } = this.endpoint();
    const userContent: unknown[] = [];
    for (const part of req.userParts) {
      if (part.type === 'text' && part.text) {
        userContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image' && part.imageJpeg && this.supportsVision) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${part.imageJpeg.toString('base64')}`,
          },
        });
      }
    }

    const body = {
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: req.toolName,
          ...(req.toolDescription ? { description: req.toolDescription } : {}),
          strict: false,
          schema: req.jsonSchema,
        },
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Extract ${this.driver} HTTP ${resp.status}: ${text.slice(0, 800)}`);
    }
    const json = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Extract ${this.driver} returned empty content`);
    return JSON.parse(content) as unknown;
  }

  private endpoint(): { url: string; headers: Record<string, string> } {
    if (this.driver === 'ollama') {
      const host = (process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
      return {
        url: `${host}/v1/chat/completions`,
        headers: { 'Content-Type': 'application/json' },
      };
    }
    if (!process.env['OPENAI_API_KEY']) {
      throw new Error('OPENAI_API_KEY is required for extract driver openai');
    }
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env['OPENAI_API_KEY']}`,
      },
    };
  }
}
