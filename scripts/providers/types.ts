import type { ChunkFormat } from '../lib/audio-chunk.ts';

export interface Transcriber {
  readonly driver: string;
  /** Container ffmpeg writes for each chunk this transcriber reads (lib/audio-chunk.ts). */
  readonly chunkFormat: ChunkFormat;
  /** Seconds of the lesson per request, and how far each chunk runs into the next. */
  readonly chunkSeconds: number;
  readonly overlapSeconds: number;
  /** `seconds` is the chunk's length, for telling a quiet chunk from one whose speech was dropped. */
  transcribe(audioPath: string, hint: string, seconds: number): Promise<string>;
}

export type ExtractMessagePart =
  | { type: 'text'; text: string; imageJpeg?: never }
  | { type: 'image'; imageJpeg: Buffer; text?: never };

export interface ExtractRequest {
  signal?: AbortSignal;
  timeoutMs?: number;
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
