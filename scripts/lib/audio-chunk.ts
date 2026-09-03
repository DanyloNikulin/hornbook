// What ffmpeg writes for each transcription chunk.
//
// OpenAI takes a compact opus .ogg (a 15-minute chunk is ~3 MB to upload).
// whisper.cpp does not: its decoder reads 16-bit PCM WAV (and a few
// lossy formats via miniaudio, none of them ogg/opus), and answers
// "failed to read audio file" for anything else. Local chunks stay on disk
// in the job's work dir, so size is not a concern there — WAV it is.

export type ChunkFormat = 'ogg' | 'wav';

const OPUS_BITRATE_KBPS = 24;

/** File name of chunk `index` in the work dir. */
export function chunkFileName(index: number, format: ChunkFormat): string {
  return `chunk-${String(index).padStart(3, '0')}.${format}`;
}

/** Codec arguments (after the shared mono/16 kHz downmix) for one chunk. */
export function chunkEncodeArgs(format: ChunkFormat): string[] {
  return format === 'wav'
    ? ['-c:a', 'pcm_s16le']
    : ['-c:a', 'libopus', '-b:a', `${OPUS_BITRATE_KBPS}k`];
}
