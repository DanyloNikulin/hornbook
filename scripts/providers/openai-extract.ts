import { postJson } from './http.ts';
import type { ExtractRequest, Extractor } from './types.ts';

/**
 * OpenAI Chat Completions with a JSON schema response format. Every OpenAI
 * chat model the picker lists reads images, so frames always go in.
 * (Ollama has its own driver, ollama-extract.ts, on Ollama's native API.)
 */
export class OpenAiExtractor implements Extractor {
  readonly driver = 'openai';
  /** Pause before the one retry of a request that never reached HTTP (see http.ts). */
  retryPauseMs = 2000;

  constructor(private readonly model: string) {}

  hasVision(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async extract(req: ExtractRequest): Promise<unknown> {
    const key = process.env['OPENAI_API_KEY'];
    if (!key) throw new Error('OPENAI_API_KEY is required for extract driver openai');

    const userContent: unknown[] = [];
    for (const part of req.userParts) {
      if (part.type === 'text' && part.text) {
        userContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image' && part.imageJpeg) {
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${part.imageJpeg.toString('base64')}` },
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

    const resp = await postJson(
      'https://api.openai.com/v1/chat/completions',
      body,
      { Authorization: `Bearer ${key}` },
      'openai',
      this.retryPauseMs,
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Extract openai HTTP ${resp.status}: ${text.slice(0, 800)}`);
    }
    const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('Extract openai returned empty content');
    return JSON.parse(content) as unknown;
  }
}
