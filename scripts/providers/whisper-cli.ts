import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transcriber } from './types.ts';
import { whisperModelPath } from '../lib/whisper-model.ts';

/**
 * Arguments for whisper-cli. The language is auto-detected per chunk: a
 * lesson mixes the target language with the learner's, and whisper.cpp's
 * default is English, which mangles anything else.
 *
 * The lesson hint is deliberately NOT passed as `--prompt`. Whisper mimics
 * the prompt's style rather than following it, and on a test recording with
 * the tiny model the instruction text made the transcript worse; a
 * target-language word list fixed one spelling and broke another. Nothing
 * beat no prompt at all.
 */
export function whisperArgs(modelPath: string, audioPath: string, outBase: string): string[] {
  return ['-m', modelPath, '-f', audioPath, '-l', 'auto', '-otxt', '-of', outBase];
}

export class WhisperCliTranscriber implements Transcriber {
  readonly driver = 'whisper-cli';
  /** whisper.cpp reads PCM WAV; it cannot open the opus chunks OpenAI gets. */
  readonly chunkFormat = 'wav';

  constructor(private readonly model: string) {}

  async transcribe(audioPath: string, _hint: string): Promise<string> {
    const bin = process.env['WHISPER_BIN'] ?? 'whisper-cli';
    const modelPath = whisperModelPath(this.model, process.env);
    const outDir = mkdtempSync(join(tmpdir(), 'hornbook-whisper-'));
    const args = whisperArgs(modelPath, audioPath, join(outDir, 'out'));

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on('error', (e) => {
        reject(
          new Error(
            `whisper-cli failed to start (${bin}). Set WHISPER_BIN to your whisper.cpp binary. ${e.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`whisper-cli exited ${code}: ${err.slice(0, 800)}`));
      });
    });

    const txtPath = join(outDir, 'out.txt');
    if (!existsSync(txtPath)) {
      throw new Error(`whisper-cli produced no transcript at ${txtPath}`);
    }
    return readFileSync(txtPath, 'utf8');
  }
}
