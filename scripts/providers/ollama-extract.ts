// Ollama through its native /api/chat, not the OpenAI-compatible endpoint.
// The native call takes `options.num_ctx`; the compatible one cannot, and
// Ollama's own default context of 4k tokens is too small for a lesson:
// gemma3:4b with four slide images returned JSON cut off mid-string, and a
// long transcript would lose its start (with the system prompt) silently.
// The schema goes in `format`, which Ollama enforces as a grammar.

import { postJson } from './http.ts';
import { ollamaCapabilities, ollamaHost } from './ollama.ts';
import type { ExtractRequest, Extractor } from './types.ts';

/** Enough for an hour-long transcript plus a full lesson; OLLAMA_NUM_CTX overrides. */
export const DEFAULT_NUM_CTX = 16384;

export function ollamaNumCtx(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['OLLAMA_NUM_CTX']);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_NUM_CTX;
}

interface ChatReply {
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaExtractor implements Extractor {
  readonly driver = 'ollama';
  /** Pause before the one retry of a request that never reached HTTP (see http.ts). */
  retryPauseMs = 2000;
  private vision?: Promise<boolean>;

  constructor(private readonly model: string) {}

  /** Images go in when the pulled model lists the vision capability (asked once). */
  hasVision(): Promise<boolean> {
    this.vision ??= ollamaCapabilities(ollamaHost(), this.model).then((caps) => caps?.includes('vision') ?? false);
    return this.vision;
  }

  async extract(req: ExtractRequest): Promise<unknown> {
    const host = ollamaHost();
    const vision = await this.hasVision();
    const numCtx = ollamaNumCtx();
    const text = req.userParts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n\n');
    const images = vision
      ? req.userParts.filter((p) => p.type === 'image' && p.imageJpeg).map((p) => p.imageJpeg!.toString('base64'))
      : [];
    // The compatible endpoint carried the tool description on the schema;
    // the native format field has no room for it, so it rides on the prompt.
    const system = req.toolDescription
      ? `${req.system}\n\nAnswer with one JSON object for ${req.toolName}: ${req.toolDescription}`
      : req.system;

    const body = {
      model: this.model,
      stream: false,
      format: req.jsonSchema,
      options: { temperature: 0, num_ctx: numCtx },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text, ...(images.length ? { images } : {}) },
      ],
    };

    const resp = await postJson(`${host}/api/chat`, body, {}, 'ollama', this.retryPauseMs);
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`Extract ollama HTTP ${resp.status}: ${detail.slice(0, 800)}`);
    }
    const json = (await resp.json()) as ChatReply;
    const content = json.message?.content;
    if (!content) throw new Error('Extract ollama returned empty content');
    try {
      return JSON.parse(content) as unknown;
    } catch (err) {
      const tokens = `prompt ${json.prompt_eval_count ?? '?'} + answer ${json.eval_count ?? '?'} tokens of a ${numCtx} context, done_reason=${json.done_reason ?? '?'}`;
      throw new Error(
        `Extract ollama: ${this.model} did not return valid JSON (${(err as Error).message}; ${tokens}). ` +
          'If the answer was cut off, set OLLAMA_NUM_CTX higher or pick a larger model.',
      );
    }
  }
}
