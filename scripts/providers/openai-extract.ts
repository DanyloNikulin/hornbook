import type { ExtractRequest, Extractor } from './types.ts';
import { ollamaCapabilities, ollamaHost } from './ollama.ts';

/**
 * OpenAI Chat Completions and Ollama's OpenAI-compatible /v1/chat/completions.
 * Images go to OpenAI always, and to Ollama when the pulled model lists the
 * vision capability (gemma3, qwen2.5vl, llama3.2-vision…). A text-only model
 * gets the text parts only, so a stray image never turns into a 400.
 */
export class OpenAiCompatibleExtractor implements Extractor {
  readonly driver: 'openai' | 'ollama';
  private vision?: Promise<boolean>;

  constructor(
    driver: 'openai' | 'ollama',
    private readonly model: string,
  ) {
    this.driver = driver;
  }

  hasVision(): Promise<boolean> {
    this.vision ??=
      this.driver === 'openai'
        ? Promise.resolve(true)
        : ollamaCapabilities(ollamaHost(), this.model).then((caps) => caps?.includes('vision') ?? false);
    return this.vision;
  }

  async extract(req: ExtractRequest): Promise<unknown> {
    const { url, headers } = this.endpoint();
    const vision = await this.hasVision();
    const userContent: unknown[] = [];
    for (const part of req.userParts) {
      if (part.type === 'text' && part.text) {
        userContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image' && part.imageJpeg && vision) {
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
      return {
        url: `${ollamaHost()}/v1/chat/completions`,
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
