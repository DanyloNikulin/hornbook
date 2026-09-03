import Anthropic from '@anthropic-ai/sdk';
import type { ImageBlockParam, MessageParam, TextBlockParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ExtractRequest, Extractor } from './types.ts';

export class AnthropicExtractor implements Extractor {
  readonly driver = 'anthropic';

  hasVision(): Promise<boolean> {
    return Promise.resolve(true);
  }

  constructor(private readonly model: string) {}

  async extract(req: ExtractRequest): Promise<unknown> {
    if (!process.env['ANTHROPIC_API_KEY']) {
      throw new Error('ANTHROPIC_API_KEY is required for extract driver anthropic');
    }
    const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
    const content: (TextBlockParam | ImageBlockParam)[] = [];
    for (const part of req.userParts) {
      if (part.type === 'text' && part.text) {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image' && part.imageJpeg) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: part.imageJpeg.toString('base64'),
          },
        });
      }
    }

    const tools: Tool[] = [
      {
        name: req.toolName,
        description: req.toolDescription ?? 'Save the structured lesson. Call exactly once.',
        input_schema: req.jsonSchema as Tool['input_schema'],
      },
    ];

    const messages: MessageParam[] = [{ role: 'user', content }];
    const resp = await client.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: req.system,
      tools,
      tool_choice: { type: 'tool', name: req.toolName },
      messages,
    });

    const toolUse = resp.content.find(
      (c) => c.type === 'tool_use' && c.name === req.toolName,
    );
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(`Extract model did not call ${req.toolName}. stop=${resp.stop_reason}`);
    }
    return toolUse.input;
  }
}
