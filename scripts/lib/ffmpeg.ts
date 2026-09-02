// Thin wrappers around ffmpeg / ffprobe. Assumes both are on PATH.
// Windows: winget install Gyan.FFmpeg. Linux (CI): apt-get install ffmpeg.

import { spawn } from 'node:child_process';

export function ffmpeg(args: string[], { silent = true }: { silent?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
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

export function ffprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-hide_banner', '-loglevel', 'error', ...args], {
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
