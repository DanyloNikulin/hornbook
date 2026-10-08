import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiTranscriber, heardSegments, type TranscriptionRequest } from './openai-transcribe.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function fakeSend(answers: Record<string, string>): ReturnType<typeof vi.fn<(req: TranscriptionRequest) => Promise<string>>> {
  return vi.fn((req: TranscriptionRequest) => Promise.resolve(answers[req.model] ?? ''));
}

describe('OpenAiTranscriber', () => {
  it('asks for three-minute chunks, short enough for the answer cap', () => {
    const t = new OpenAiTranscriber('gpt-4o-transcribe');
    expect(t.chunkSeconds).toBe(180);
    expect(t.overlapSeconds).toBeLessThan(t.chunkSeconds / 10);
  });

  it('keeps the first answer when it heard a lesson-like amount of speech', async () => {
    const send = fakeSend({ 'gpt-4o-transcribe': words(150) });
    const text = await new OpenAiTranscriber('gpt-4o-transcribe', send).transcribe('c.ogg', 'HINT', 185);
    expect(text).toBe(words(150));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ model: 'gpt-4o-transcribe', audioPath: 'c.ogg', prompt: 'HINT' });
  });

  it('asks whisper-1, without the hint, when a chunk came back nearly empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = fakeSend({ 'gpt-4o-transcribe': words(20), 'whisper-1': words(216) });
    const text = await new OpenAiTranscriber('gpt-4o-transcribe', send).transcribe('c.ogg', 'HINT', 185);
    expect(text).toBe(words(216));
    expect(send).toHaveBeenLastCalledWith({ model: 'whisper-1', audioPath: 'c.ogg' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/heard 20 word\(s\) in 185 s; whisper-1 heard 216, using it/));
  });

  it('keeps the first answer when whisper-1 hears no more', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = fakeSend({ 'gpt-4o-transcribe': words(10), 'whisper-1': words(4) });
    expect(await new OpenAiTranscriber('gpt-4o-transcribe', send).transcribe('c.ogg', 'HINT', 185)).toBe(words(10));
  });

  it('has no second try when whisper-1 is the configured model', async () => {
    const send = fakeSend({ 'whisper-1': words(3) });
    expect(await new OpenAiTranscriber('whisper-1', send).transcribe('c.ogg', 'HINT', 185)).toBe(words(3));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('expects fewer words from a short last chunk', async () => {
    const send = fakeSend({ 'gpt-4o-transcribe': words(3) });
    await new OpenAiTranscriber('gpt-4o-transcribe', send).transcribe('c.ogg', 'HINT', 8);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('heardSegments', () => {
  it('drops segments Whisper made up over silence and repeats of the one before', () => {
    expect(
      heardSegments([
        { text: ' Ciao a tutti.', no_speech_prob: 0.1, avg_logprob: -0.3 },
        { text: ' Grazie per la visione!', no_speech_prob: 0.9, avg_logprob: -1.4 },
        { text: ' Vado a mangiare.', no_speech_prob: 0.7, avg_logprob: -0.2 },
        { text: ' Vado a mangiare.', no_speech_prob: 0.1, avg_logprob: -0.2 },
        { text: '   ' },
        { text: ' Buonasera.' },
      ]),
    ).toBe('Ciao a tutti. Vado a mangiare. Buonasera.');
  });
});
