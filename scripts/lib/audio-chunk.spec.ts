import { describe, expect, it } from 'vitest';
import { chunkEncodeArgs, chunkFileName } from './audio-chunk';

describe('audio chunks', () => {
  it('names chunks by index with the container extension', () => {
    expect(chunkFileName(0, 'ogg')).toBe('chunk-000.ogg');
    expect(chunkFileName(12, 'wav')).toBe('chunk-012.wav');
  });

  it('writes PCM WAV for whisper.cpp and opus for uploads', () => {
    expect(chunkEncodeArgs('wav')).toEqual(['-c:a', 'pcm_s16le']);
    expect(chunkEncodeArgs('ogg')).toEqual(['-c:a', 'libopus', '-b:a', '24k']);
  });
});
