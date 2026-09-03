import type { ChunkFormat } from '../lib/audio-chunk.ts';

export interface Transcriber {
  readonly driver: string;
  /** Container ffmpeg writes for each chunk this transcriber reads (lib/audio-chunk.ts). */
  readonly chunkFormat: ChunkFormat;
  transcribe(audioPath: string, hint: string): Promise<string>;
}

export interface ExtractMessagePart {
  type: 'text' | 'image';
  text?: string;
  /** Raw JPEG bytes for vision drivers. */
  imageJpeg?: Buffer;
}

export interface ExtractRequest {
  system: string;
  userParts: ExtractMessagePart[];
  jsonSchema: Record<string, unknown>;
  toolName: string;
  /** What the tool does. Anthropic sees it on the tool, OpenAI-style APIs on the schema. */
  toolDescription?: string;
}

export interface Extractor {
  readonly driver: string;
  /** Whether images can go in the request. Ollama answers per pulled model, hence async. */
  hasVision(): Promise<boolean>;
  extract(req: ExtractRequest): Promise<unknown>;
}
