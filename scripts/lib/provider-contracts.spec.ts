import { describe, expect, expectTypeOf, it } from 'vitest';
import { JournalConfig, Providers, SectionConfig } from '../../src/lib/journal-config.ts';
import { PROVIDER_DRIVERS } from '../../src/lib/provider-capabilities.ts';
import { PIPELINE_PATHS } from '../../src/lib/pipeline.ts';
import type { ExtractMessagePart } from '../providers/types.ts';

describe('provider roles at configuration boundaries', () => {
  it('keeps pipeline choices aligned with the capability table', () => {
    for (const role of ['transcribe', 'extract'] as const) {
      expect(PIPELINE_PATHS.filter((path) => path.job === role).map((path) => path.driver).sort()).toEqual([...PROVIDER_DRIVERS[role]].sort());
    }
  });
  it('requires the payload associated with each message kind', () => {
    expectTypeOf<{ type: 'text' }>().not.toExtend<ExtractMessagePart>();
    expectTypeOf<{ type: 'image'; text: string }>().not.toExtend<ExtractMessagePart>();
    expectTypeOf<{ type: 'text'; text: string }>().toExtend<ExtractMessagePart>();
    expectTypeOf<{ type: 'image'; imageJpeg: Buffer }>().toExtend<ExtractMessagePart>();
  });
  const providers = { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'ollama', model: 'local' } };
  it.each(['anthropic', 'ollama', 'claude-cli', 'codex-cli', 'grok-cli', 'kimi-cli'])('rejects %s for transcription', (driver) => {
    expect(Providers.safeParse({ ...providers, transcribe: { driver, model: '-' } }).success).toBe(false);
  });
  it.each(['whisper-cli', 'skip'])('rejects %s for extraction, including section overrides', (driver) => {
    expect(Providers.safeParse({ ...providers, extract: { driver, model: '-' } }).success).toBe(false);
    expect(SectionConfig.safeParse({ id: 'es-en', target: 'es', learner: 'en', providers: { extract: { driver, model: '-' } } }).success).toBe(false);
  });
  it('accepts supported defaults and rejects invalid journal-level roles', () => {
    const config = { brand: { name: 'Test', tagline: 'Test' }, providers };
    expect(JournalConfig.safeParse(config).success).toBe(true);
    expect(JournalConfig.safeParse({ ...config, providers: { ...providers, transcribe: { driver: 'anthropic', model: 'test' } } }).success).toBe(false);
  });
});
