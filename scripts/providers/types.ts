export interface Transcriber {
  readonly driver: string;
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
}

export interface Extractor {
  readonly driver: string;
  readonly supportsVision: boolean;
  extract(req: ExtractRequest): Promise<unknown>;
}
