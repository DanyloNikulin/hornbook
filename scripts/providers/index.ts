import { currentProviders } from '../lib/config.ts';
import type { Extractor, Transcriber } from './types.ts';
import { OpenAiTranscriber } from './openai-transcribe.ts';
import { WhisperCliTranscriber } from './whisper-cli.ts';
import { AnthropicExtractor } from './anthropic-extract.ts';
import { OpenAiCompatibleExtractor } from './openai-extract.ts';

export function getTranscriber(): Transcriber {
  const { driver, model } = currentProviders().transcribe;
  if (driver === 'skip') {
    throw new Error(
      'Hearing is skipped. Pass a transcript (.txt) or set up whisper.cpp / OpenAI in Application settings.',
    );
  }
  if (driver === 'openai') return new OpenAiTranscriber(model);
  if (driver === 'whisper-cli') return new WhisperCliTranscriber(model);
  throw new Error(
    `Transcribe driver "${driver}" is not supported. Use openai, whisper-cli, or skip.`,
  );
}

export function getExtractor(): Extractor {
  const { driver, model } = currentProviders().extract;
  if (driver === 'anthropic') return new AnthropicExtractor(model);
  if (driver === 'openai' || driver === 'ollama') {
    return new OpenAiCompatibleExtractor(driver, model);
  }
  throw new Error(
    `Extract driver "${driver}" is not supported. Use anthropic, openai, or ollama.`,
  );
}

export type { Extractor, Transcriber, ExtractRequest, ExtractMessagePart } from './types.ts';
