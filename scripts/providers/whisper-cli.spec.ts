import { describe, expect, it } from 'vitest';
import { whisperArgs } from './whisper-cli.ts';

describe('whisperArgs', () => {
  it('auto-detects the language instead of whisper.cpp’s English default', () => {
    expect(whisperArgs('ggml-base.bin', 'chunk-000.wav', 'C:/tmp/out')).toEqual([
      '-m',
      'ggml-base.bin',
      '-f',
      'chunk-000.wav',
      '-l',
      'auto',
      '-otxt',
      '-of',
      'C:/tmp/out',
    ]);
  });

  it('passes no initial prompt: it steers style, not content, and hurt in testing', () => {
    expect(whisperArgs('m.bin', 'a.wav', 'out')).not.toContain('--prompt');
  });
});
