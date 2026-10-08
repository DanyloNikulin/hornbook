import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import type { Transcriber } from './types.ts';

/**
 * gpt-4o-transcribe stops answering after about 2,000 tokens. A busy
 * 15-minute lesson chunk in Cyrillic runs past that: two chunks of a real
 * lesson ended mid-word and another came back looping one paragraph. Three
 * minutes stays at a quarter of the cap.
 */
const CHUNK_SECONDS = 3 * 60;
const OVERLAP_SECONDS = 5;

/**
 * Even short chunks sometimes come back from gpt-4o-transcribe as a sentence
 * or two, mostly where the lesson plays or reads aloud a text. A lesson runs
 * at 45–90 words a minute; far below that, speech was dropped and whisper-1,
 * which hears those chunks, gets a second try.
 */
const MIN_WORDS_PER_MINUTE = 20;
const FALLBACK_MODEL = 'whisper-1';

/** Whisper's own rule for a segment it made up out of silence. */
const NO_SPEECH_PROB = 0.6;
const NO_SPEECH_LOGPROB = -1;

export interface TranscriptionRequest {
  model: string;
  audioPath: string;
  prompt?: string;
}

export type SendTranscription = (req: TranscriptionRequest) => Promise<string>;

export class OpenAiTranscriber implements Transcriber {
  readonly driver = 'openai';
  /** Uploads: keep chunks small. */
  readonly chunkFormat = 'ogg';
  readonly chunkSeconds = CHUNK_SECONDS;
  readonly overlapSeconds = OVERLAP_SECONDS;

  constructor(
    private readonly model: string,
    private readonly send: SendTranscription = sendToOpenAi,
  ) {}

  async transcribe(audioPath: string, hint: string, seconds: number): Promise<string> {
    const text = await this.send({ model: this.model, audioPath, prompt: hint });
    const heard = countWords(text);
    if (this.model === FALLBACK_MODEL || heard >= (MIN_WORDS_PER_MINUTE * seconds) / 60) return text;
    // No hint here: an English instruction as a Whisper prompt pulls the
    // transcript toward English instead of steering it.
    const fallback = await this.send({ model: FALLBACK_MODEL, audioPath });
    const recovered = countWords(fallback);
    console.warn(
      `${this.model} heard ${heard} word(s) in ${Math.round(seconds)} s; ${FALLBACK_MODEL} heard ${recovered}` +
        (recovered > heard ? ', using it.' : ', keeping the first answer.'),
    );
    return recovered > heard ? fallback : text;
  }
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

interface WhisperSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

/** Whisper's segments without the ones it invented over silence or repeated in a loop. */
export function heardSegments(segments: readonly WhisperSegment[]): string {
  const kept: string[] = [];
  for (const s of segments) {
    const text = s.text.trim();
    const silent = (s.no_speech_prob ?? 0) > NO_SPEECH_PROB && (s.avg_logprob ?? 0) < NO_SPEECH_LOGPROB;
    if (!text || silent || text === kept.at(-1)) continue;
    kept.push(text);
  }
  return kept.join(' ');
}

async function sendToOpenAi({ model, audioPath, prompt }: TranscriptionRequest): Promise<string> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for transcribe driver openai');
  const client = new OpenAI({ apiKey });
  const file = createReadStream(audioPath);
  if (model === FALLBACK_MODEL) {
    // Only whisper-1 reports segments, and with them how likely each is silence.
    const resp = await client.audio.transcriptions.create({
      file,
      model,
      ...(prompt ? { prompt } : {}),
      response_format: 'verbose_json',
    });
    return resp.segments ? heardSegments(resp.segments) : resp.text;
  }
  const resp = await client.audio.transcriptions.create({
    file,
    model,
    ...(prompt ? { prompt } : {}),
    response_format: 'text',
  });
  return typeof resp === 'string' ? resp : ((resp as { text?: string }).text ?? String(resp));
}
