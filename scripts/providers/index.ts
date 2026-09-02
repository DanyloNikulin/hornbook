import { loadJournalConfig } from '../lib/config.ts';
import type { Extractor, Transcriber } from './types.ts';
import { OpenAiTranscriber } from './openai-transcribe.ts';
import { WhisperCliTranscriber } from './whisper-cli.ts';
import { AnthropicExtractor } from './anthropic-extract.ts';
import { OpenAiCompatibleExtractor } from './openai-extract.ts';

export function getTranscriber(): Transcriber {
  const { driver, model } = loadJournalConfig().providers.transcribe;
  if (driver === 'openai') return new OpenAiTranscriber(model);
  if (driver === 'whisper-cli') return new WhisperCliTranscriber(model);
  throw new Error(
    `Transcribe driver "${driver}" is not supported. Use openai or whisper-cli.`,
  );
}

export function getExtractor(): Extractor {
  const { driver, model } = loadJournalConfig().providers.extract;
  if (driver === 'anthropic') return new AnthropicExtractor(model);
  if (driver === 'openai' || driver === 'ollama') {
    return new OpenAiCompatibleExtractor(driver, model);
  }
  throw new Error(
    `Extract driver "${driver}" is not supported. Use anthropic, openai, or ollama.`,
  );
}

export type { Extractor, Transcriber, ExtractRequest, ExtractMessagePart } from './types.ts';
