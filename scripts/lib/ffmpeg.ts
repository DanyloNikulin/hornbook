// Thin wrappers around ffmpeg / ffprobe. Assumes both are on PATH.
// Windows: winget install Gyan.FFmpeg. Linux (CI): apt-get install ffmpeg.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

function ffmpegBin(): string {
  return process.env['FFMPEG_BIN']?.trim() || 'ffmpeg';
}

function ffprobeBin(): string {
  const explicit = process.env['FFPROBE_BIN']?.trim();
  if (explicit) return explicit;
  const configured = process.env['FFMPEG_BIN']?.trim();
  if (!configured) return 'ffprobe';
  return join(dirname(configured), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

export function ffmpeg(args: string[], { silent = true }: { silent?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stderr = '';
    if (silent && child.stderr) child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)),
    );
  });
}

/** ffmpeg output kept in memory; intended for tiny analytical rasters only. */
export function ffmpegBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)),
    );
  });
}

export function ffprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin(), ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    if (child.stderr) child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(`ffprobe exit ${code}: ${stderr}`)),
    );
  });
}

export async function durationSeconds(input: string): Promise<number> {
  const out = await ffprobe([
    '-i',
    input,
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
  ]);
  const n = Number(out);
  if (!Number.isFinite(n)) throw new Error(`Could not read duration of ${input}: ${out}`);
  return n;
}
