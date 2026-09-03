// Builds harness/fixtures/lesson.mp4: four real slides with text (rendered
// from SVG by sharp, so no ffmpeg drawtext quirks) over a spoken intro, plus
// the matching transcript.txt. The result is committed; run this only to
// change the fixture.
//
// Speech comes from whatever the OS offers: Windows SAPI (System.Speech),
// macOS `say`, or espeak-ng on Linux. ffmpeg must be on PATH.
//
//   npm run harness:fixture

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { fixturesDir, outDir, run } from './lib.ts';

const W = 1280;
const H = 720;
const SECONDS_PER_SLIDE = 6;

interface Slide {
  bg: string;
  ink: string;
  title: string;
  lines: string[];
}

/** Distinct colours and layouts so the 8×8 average hash tells them apart. */
const SLIDES: Slide[] = [
  { bg: '#1b365d', ink: '#f4ecdf', title: 'Saludos', lines: ['Spanish greetings', 'Lesson 1'] },
  {
    bg: '#f4ecdf',
    ink: '#2a2520',
    title: 'Palabras',
    lines: ['Hola — hello', 'Buenos días — good morning', 'Buenas tardes — good afternoon', 'Buenas noches — good night'],
  },
  { bg: '#2f5a3a', ink: '#f4ecdf', title: '¿tú o usted?', lines: ['¿Cómo estás? — friends', '¿Cómo está usted? — formal'] },
  { bg: '#7a2a2a', ink: '#f4ecdf', title: 'Mucho gusto', lines: ['Nice to meet you', 'Igualmente — likewise'] },
];

const SPEECH =
  'Hello. Today we study Spanish greetings. Hola means hello. Buenos dias means good morning. ' +
  'Use tu with friends and usted in formal situations. Mucho gusto means nice to meet you.';

const TRANSCRIPT = `[00:00] teacher: Hola. Today we study Spanish greetings.
[00:05] teacher: Hola means hello. You can use it any time of day.
[00:09] teacher: Buenos días is good morning. Buenas tardes is good afternoon. Buenas noches is good night.
[00:14] teacher: With friends use tú: ¿Cómo estás? In a shop or with someone older use usted: ¿Cómo está usted?
[00:19] teacher: When you meet someone, say mucho gusto. It means nice to meet you. The answer is igualmente.
[00:23] student: Hola, me llamo Alex. Mucho gusto.
[00:25] teacher: Perfecto. Igualmente.
`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svg(slide: Slide, index: number): string {
  const body = slide.lines
    .map((line, i) => `<text x="120" y="${330 + i * 78}" font-size="56" font-family="Georgia, 'DejaVu Serif', serif" fill="${slide.ink}">${esc(line)}</text>`)
    .join('\n');
  // A wide bar on alternating sides makes the low-resolution hashes of two
  // slides differ even when their colours happen to average alike.
  const bar = index % 2 === 0 ? `<rect x="0" y="0" width="60" height="${H}" fill="${slide.ink}" opacity="0.8"/>` : `<rect x="${W - 60}" y="0" width="60" height="${H}" fill="${slide.ink}" opacity="0.8"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${slide.bg}"/>
  ${bar}
  <text x="120" y="200" font-size="110" font-weight="bold" font-family="Georgia, 'DejaVu Serif', serif" fill="${slide.ink}">${esc(slide.title)}</text>
  ${body}
  <text x="${W - 120}" y="${H - 50}" font-size="34" text-anchor="end" font-family="Arial, 'DejaVu Sans', sans-serif" fill="${slide.ink}" opacity="0.7">${index + 1} / ${SLIDES.length}</text>
</svg>`;
}

async function speak(wav: string): Promise<void> {
  if (process.platform === 'win32') {
    const ps = join(outDir, 'fixture', 'tts.ps1');
    writeFileSync(
      ps,
      [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        '$s.Rate = -1',
        `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')`,
        `$s.Speak('${SPEECH.replace(/'/g, "''")}')`,
        '$s.Dispose()',
      ].join('\n'),
    );
    const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps]);
    if (r.code !== 0) throw new Error(`SAPI failed: ${r.out.slice(-400)}`);
    return;
  }
  if (process.platform === 'darwin') {
    const aiff = wav.replace(/\.wav$/, '.aiff');
    const r = await run('say', ['-o', aiff, SPEECH]);
    if (r.code !== 0) throw new Error(`say failed: ${r.out.slice(-400)}`);
    const f = await run('ffmpeg', ['-y', '-i', aiff, wav]);
    if (f.code !== 0) throw new Error(`ffmpeg aiff→wav failed: ${f.out.slice(-400)}`);
    return;
  }
  const r = await run('espeak-ng', ['-w', wav, SPEECH]);
  if (r.code !== 0) throw new Error(`espeak-ng failed (install it, or build the fixture on Windows/macOS): ${r.out.slice(-400)}`);
}

async function main(): Promise<void> {
  const work = join(outDir, 'fixture');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });

  for (const [i, slide] of SLIDES.entries()) {
    const png = join(work, `slide-${i + 1}.png`);
    await sharp(Buffer.from(svg(slide, i))).png().toFile(png);
    console.log(`slide ${i + 1}: ${slide.title} -> ${png}`);
  }

  const rawWav = join(work, 'speech-raw.wav');
  await speak(rawWav);
  if (!existsSync(rawWav)) throw new Error('No speech file was written.');
  const wav = join(work, 'speech.wav');
  const norm = await run('ffmpeg', ['-y', '-i', rawWav, '-ar', '16000', '-ac', '1', wav]);
  if (norm.code !== 0) throw new Error(`ffmpeg wav failed: ${norm.out.slice(-400)}`);

  // Each PNG stays on screen SECONDS_PER_SLIDE; the audio runs alongside and
  // the container is as long as the longer of the two.
  const mp4 = join(fixturesDir, 'lesson.mp4');
  const enc = await run('ffmpeg', [
    '-y',
    '-framerate',
    `1/${SECONDS_PER_SLIDE}`,
    '-i',
    join(work, 'slide-%d.png'),
    '-i',
    wav,
    '-c:v',
    'libx264',
    '-r',
    '10',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '48k',
    mp4,
  ]);
  if (enc.code !== 0) throw new Error(`ffmpeg mp4 failed: ${enc.out.slice(-600)}`);
  writeFileSync(join(fixturesDir, 'transcript.txt'), TRANSCRIPT, 'utf8');
  console.log(`\n✓ ${mp4}`);
  console.log(`✓ ${join(fixturesDir, 'transcript.txt')}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
