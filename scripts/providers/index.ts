import { currentProviders } from '../lib/config.ts';
import type { Extractor, Transcriber } from './types.ts';
import { OpenAiTranscriber } from './openai-transcribe.ts';
import { WhisperCliTranscriber } from './whisper-cli.ts';
import { AnthropicExtractor } from './anthropic-extract.ts';
import { OpenAiExtractor } from './openai-extract.ts';
import { OllamaExtractor } from './ollama-extract.ts';
import { CliExtractor } from './cli-extract.ts';

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
  if (driver === 'openai') return new OpenAiExtractor(model);
  if (driver === 'ollama') return new OllamaExtractor(model);
  if (driver === 'claude-cli') return new CliExtractor('claude', model);
  if (driver === 'codex-cli') return new CliExtractor('codex', model);
  if (driver === 'grok-cli') return new CliExtractor('grok', model);
  if (driver === 'kimi-cli') return new CliExtractor('kimi', model);
  throw new Error(
    `Extract driver "${driver}" is not supported. Use anthropic, openai, ollama, claude-cli, codex-cli, grok-cli, or kimi-cli.`,
  );
}

export type { Extractor, Transcriber, ExtractRequest, ExtractMessagePart } from './types.ts';
