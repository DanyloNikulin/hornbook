import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import type { Transcriber } from './types.ts';

export class OpenAiTranscriber implements Transcriber {
  readonly driver = 'openai';
  /** Uploads: keep chunks small. */
  readonly chunkFormat = 'ogg';

  constructor(private readonly model: string) {}

  async transcribe(audioPath: string, hint: string): Promise<string> {
    if (!process.env['OPENAI_API_KEY']) {
      throw new Error('OPENAI_API_KEY is required for transcribe driver openai');
    }
    const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });
    const resp = await client.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: this.model,
      prompt: hint,
      response_format: 'text',
    });
    return typeof resp === 'string' ? resp : ((resp as { text?: string }).text ?? String(resp));
  }
}
