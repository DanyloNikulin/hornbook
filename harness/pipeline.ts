// Zero-cost pipeline end to end on the slide fixture: ffmpeg frames,
// whisper.cpp, Ollama, and the server's job runner, against a throwaway
// journal. Nothing paid is ever called (the server is started with cloud
// keys blanked).
//
//   npm run harness:pipeline
//
// Environment:
//   WHISPER_BIN, WHISPER_MODEL    whisper.cpp binary and ggml model (else hearing steps are skipped)
//   OLLAMA_HOST                   default http://127.0.0.1:11434
//   HORNBOOK_EXTRACT_MODEL        text model, default qwen2.5:7b
//   HORNBOOK_VISION_MODEL         model with the vision capability, default gemma3:4b
//
// Steps that need a tool or a model that is not there are SKIPped, never
// failed; the summary says what actually ran.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProbeResult, JobView } from '../src/lib/api-types.ts';
import { Lesson } from '../src/lib/schema.ts';
import { extractFrames } from '../scripts/extract-frames.ts';
import { isJunkQuoteText, quoteAppearsInTranscript } from '../scripts/lib/lesson-quality.ts';
import {
  Report,
  b64,
  client,
  exists,
  fixturesDir,
  jobSummary,
  obj,
  ollamaHostFromEnv,
  outDir,
  reachable,
  readJson,
  repoRoot,
  run,
  startServer,
  throwawayJournal,
  waitJob,
  type Api,
} from './lib.ts';

const PORT = Number(process.env['HORNBOOK_HARNESS_PORT'] ?? 8799);
const EXTRACT_MODEL = process.env['HORNBOOK_EXTRACT_MODEL'] ?? 'qwen2.5:7b';
const VISION_MODEL = process.env['HORNBOOK_VISION_MODEL'] ?? 'gemma3:4b';
const WHISPER_BIN = process.env['WHISPER_BIN'];
const WHISPER_MODEL = process.env['WHISPER_MODEL'];
const JOB_TIMEOUT = 12 * 60 * 1000;

const video = join(fixturesDir, 'lesson.mp4');
const transcript = join(fixturesDir, 'transcript.txt');

function pulledHas(pulled: readonly string[], model: string): boolean {
  return pulled.some((n) => n === model || n.startsWith(`${model}:`));
}

async function processJob(api: Api, body: Record<string, unknown>): Promise<JobView | undefined> {
  const job = await api('POST', '/api/sections/es-en/jobs', { kind: 'process', ...body });
  const id = obj(job)['id'];
  if (typeof id !== 'string') return undefined;
  return waitJob(api, id, JOB_TIMEOUT);
}

async function lessonOf(api: Api, job: JobView | undefined): Promise<Record<string, unknown> | undefined> {
  const slug = job?.result?.slug;
  if (!slug) return undefined;
  const res = await api('GET', `/api/sections/es-en/lessons/${slug}`);
  return res.status === 200 ? obj(res) : undefined;
}

function lessonShape(l: Record<string, unknown> | undefined): string {
  if (!l) return 'no lesson';
  const n = (k: string) => (Array.isArray(l[k]) ? l[k].length : 0);
  return `title="${String(l['title'])}" vocab=${n('vocabulary')} grammar=${n('grammar')} quiz=${n('quiz')} cards=${n('flashcards')} slides=${n('slides')}`;
}

async function main(): Promise<void> {
  const r = new Report('pipeline');
  const work = join(outDir, 'pipeline');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  r.section('tools');
  const ff = await run('ffmpeg', ['-version']);
  if (!r.rec('ffmpeg on PATH', ff.code === 0, ff.out.split('\n')[0])) {
    r.finish();
    return;
  }
  if (!r.rec('slide fixture present', existsSync(video) && existsSync(transcript), video)) {
    r.note('info', 'Regenerate the fixture', 'npm run harness:fixture');
    r.finish();
    return;
  }

  r.section('frames');
  const frames = await extractFrames(video, join(work, 'frames'));
  r.rec('extract-frames keeps each real slide once', frames.length >= 3 && frames.length <= 6, `kept=${frames.length} at ${frames.map((f) => f.ts).join(', ')}`);

  r.section('hearing');
  const whisper = exists(WHISPER_BIN) && exists(WHISPER_MODEL);
  if (whisper) {
    const wav = join(work, 'lesson.wav');
    const cut = await run('ffmpeg', ['-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav]);
    r.rec('ffmpeg extracts 16 kHz mono wav from the fixture', cut.code === 0, cut.out.slice(-160));
    const outBase = join(work, 'whisper-out');
    const w = await run(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wav, '-l', 'auto', '-otxt', '-of', outBase]);
    const text = existsSync(outBase + '.txt') ? (await import('node:fs')).readFileSync(outBase + '.txt', 'utf8') : '';
    r.rec('whisper-cli hears the fixture', w.code === 0 && /greet|hola|spanish|morning/i.test(text), `exit=${w.code} text=${text.slice(0, 200)}`);
  } else {
    r.skip('whisper-cli hears the fixture', 'set WHISPER_BIN and WHISPER_MODEL to a whisper.cpp install');
  }

  r.section('ollama');
  const ollama = ollamaHostFromEnv();
  let pulled: string[] = [];
  if (await reachable(`${ollama}/api/tags`)) {
    const tags = (await (await fetch(`${ollama}/api/tags`)).json()) as { models?: { name: string }[] };
    pulled = (tags.models ?? []).map((m) => m.name);
    r.rec(`Ollama at ${ollama} answers`, true, `pulled: ${pulled.join(', ') || '(none)'}`);
  } else {
    r.skip(`Ollama at ${ollama} answers`, 'not reachable; every extract step is skipped');
  }
  const hasText = pulledHas(pulled, EXTRACT_MODEL);
  const hasVision = pulledHas(pulled, VISION_MODEL);
  if (pulled.length && !hasText) r.note('info', `${EXTRACT_MODEL} is not pulled`, `ollama pull ${EXTRACT_MODEL}, or set HORNBOOK_EXTRACT_MODEL`);
  if (pulled.length && !hasVision) r.note('info', `${VISION_MODEL} is not pulled`, `slides-from-video stays unverified; ollama pull ${VISION_MODEL}, or set HORNBOOK_VISION_MODEL`);

  r.section('server');
  const journal = throwawayJournal('pipeline', {
    config: {
      brand: { name: 'Hornbook harness', tagline: 'zero-cost pipeline' },
      providers: {
        transcribe: whisper ? { driver: 'whisper-cli', model: WHISPER_MODEL } : { driver: 'skip', model: '-' },
        extract: { driver: 'ollama', model: EXTRACT_MODEL },
      },
      sections: [{ id: 'es-en', target: 'es', learner: 'en' }],
    },
    secrets: {
      ...(whisper ? { WHISPER_BIN: WHISPER_BIN!, WHISPER_MODEL: WHISPER_MODEL! } : {}),
      OLLAMA_HOST: ollama,
    },
  });
  const server = await startServer({ journal, port: PORT });
  const api = client(server.api);
  r.rec('throwaway server up', true, server.api);

  try {
    if (whisper) {
      const p = (await api('POST', '/api/settings/probe', { job: 'transcribe', driver: 'whisper-cli', model: WHISPER_MODEL })).json as ProbeResult;
      r.rec('probe whisper-cli', p.ok === true, p.detail);
    }
    if (hasText) {
      const p = (await api('POST', '/api/settings/probe', { job: 'extract', driver: 'ollama', model: EXTRACT_MODEL })).json as ProbeResult;
      r.rec(`probe ollama ${EXTRACT_MODEL}`, p.ok === true, p.detail);
    }

    r.section('process: JSON (no model)');
    const demo = readJson<Record<string, unknown>>(join(repoRoot, 'journal', 'es-en', '2026-01-01-greetings.json'));
    demo['slug'] = 'json-copy';
    demo['id'] = '2026-09-01-json-copy';
    demo['title'] = 'JSON copy';
    const copyPath = join(work, 'copy.json');
    writeFileSync(copyPath, JSON.stringify(demo));
    const jsonDone = await processJob(api, { filename: 'copy.json', base64: b64(copyPath), date: '2026-09-01', from: 'json' });
    r.rec('JSON lesson lands', jsonDone?.status === 'done' && jsonDone.result?.slug === 'json-copy', jobSummary(jsonDone));

    r.section(`process: transcript via ${EXTRACT_MODEL}`);
    if (hasText) {
      const done = await processJob(api, { filename: 'transcript.txt', base64: b64(transcript), date: '2026-09-02', from: 'transcript' });
      r.rec('transcript job finishes', done?.status === 'done' && !!done.result?.slug, jobSummary(done));
      const lesson = await lessonOf(api, done);
      const parsed = Lesson.safeParse(lesson);
      r.rec('the lesson validates and has vocabulary, a quiz and cards', parsed.success && parsed.data.vocabulary.length > 0 && parsed.data.quiz.length > 0 && parsed.data.flashcards.length > 0, lessonShape(lesson));
      if (parsed.success) {
        const fixtureText = readFileSync(transcript, 'utf8');
        const junk = parsed.data.quotes.filter((q) => isJunkQuoteText(q.text));
        r.rec('quotes are not empty speaker labels', junk.length === 0, junk.map((q) => q.text).join(' | '));
        const invented = parsed.data.quotes.filter((q) => !quoteAppearsInTranscript(q.text, fixtureText));
        r.rec('quotes that remain appear in the transcript', invented.length === 0, invented.map((q) => q.text).join(' | '));
      }
    } else {
      r.skip('transcript job finishes', `${EXTRACT_MODEL} not available`);
    }

    r.section(`process: video via whisper + ${EXTRACT_MODEL}`);
    if (whisper && hasText) {
      const done = await processJob(api, { filename: 'lesson.mp4', base64: b64(video), date: '2026-09-03', from: 'video' });
      r.rec('video job finishes (hear, frames, write)', done?.status === 'done' && !!done.result?.slug, jobSummary(done));
      const lesson = await lessonOf(api, done);
      const parsed = Lesson.safeParse(lesson);
      r.rec('the video lesson validates', parsed.success, lessonShape(lesson));
      r.rec(
        'the video lesson has vocabulary or cards to study',
        parsed.success && (parsed.data.vocabulary.length > 0 || parsed.data.flashcards.length > 0),
        lessonShape(lesson),
      );
      if (parsed.success) {
        const junk = parsed.data.quotes.filter((q) => isJunkQuoteText(q.text));
        r.rec('video quotes are not empty speaker labels', junk.length === 0, junk.map((q) => q.text).join(' | '));
      }
      r.rec('a text-only model skips the slides and says so', /no vision|skipping \d+ slide/i.test(done?.log ?? ''), (done?.log ?? '').match(/[^\n]*no vision[^\n]*/i)?.[0] ?? '');
      r.rec('no slide is invented without vision', Array.isArray(lesson?.['slides']) && lesson!['slides'].length === 0, lessonShape(lesson));
    } else {
      r.skip('video job finishes (hear, frames, write)', whisper ? `${EXTRACT_MODEL} not available` : 'whisper.cpp not configured');
    }

    r.section(`process: video via whisper + ${VISION_MODEL} (reads the slides)`);
    if (whisper && hasVision) {
      const set = await api('PUT', '/api/settings', { providers: { transcribe: { driver: 'whisper-cli', model: WHISPER_MODEL }, extract: { driver: 'ollama', model: VISION_MODEL } } });
      r.rec(`switch the journal to ${VISION_MODEL}`, set.status === 200, set.text.slice(0, 120));
      const p = (await api('POST', '/api/settings/probe', { job: 'extract', driver: 'ollama', model: VISION_MODEL })).json as ProbeResult;
      r.rec(`probe says ${VISION_MODEL} reads slides`, p.ok === true && /reads slides/.test(p.detail), p.detail);
      const done = await processJob(api, { filename: 'lesson.mp4', base64: b64(video), date: '2026-09-04', from: 'video' });
      r.rec('vision video job finishes', done?.status === 'done' && !!done.result?.slug, jobSummary(done));
      r.rec('the frames were sent as images', /via ollama \([1-9]\d* image/.test(done?.log ?? ''), (done?.log ?? '').match(/Extract via[^\n]*/)?.[0] ?? '');
      const lesson = await lessonOf(api, done);
      const slides = Array.isArray(lesson?.['slides']) ? (lesson!['slides'] as { text?: string; ts?: string }[]) : [];
      r.rec('the lesson has at least one slide read from the video', Lesson.safeParse(lesson).success && slides.length >= 1, lessonShape(lesson) + ' ' + JSON.stringify(slides.slice(0, 2)).slice(0, 300));
      await api('PUT', '/api/settings', { providers: { transcribe: { driver: 'whisper-cli', model: WHISPER_MODEL }, extract: { driver: 'ollama', model: EXTRACT_MODEL } } });
    } else {
      r.skip('vision video job finishes', whisper ? `${VISION_MODEL} not available` : 'whisper.cpp not configured');
    }

    r.section(`cheat sheet + topic review via ${EXTRACT_MODEL}`);
    if (hasText) {
      const cheat = await api('POST', '/api/sections/es-en/jobs', { kind: 'cheatsheet', force: true });
      const cheatDone = await waitJob(api, String(obj(cheat)['id']), JOB_TIMEOUT);
      const sheet = await api('GET', '/api/sections/es-en/cheatsheet');
      const cats = Array.isArray(obj(sheet)['categories']) ? (obj(sheet)['categories'] as unknown[]).length : 0;
      r.rec('cheat sheet rebuild finishes and has categories', cheatDone?.status === 'done' && cats >= 1, `${jobSummary(cheatDone)} categories=${cats}`);
      const review = await api('POST', '/api/sections/es-en/jobs', { kind: 'review-topics' });
      const reviewDone = await waitJob(api, String(obj(review)['id']), JOB_TIMEOUT);
      r.rec('topic review finishes', reviewDone?.status === 'done', jobSummary(reviewDone));
    } else {
      r.skip('cheat sheet rebuild finishes and has categories', `${EXTRACT_MODEL} not available`);
    }
  } catch (err) {
    r.rec('harness runner', false, String(err));
  } finally {
    server.stop();
  }
  r.finish({ journal, extractModel: EXTRACT_MODEL, visionModel: VISION_MODEL, whisper, pulled, serverLog: server.log().slice(-2000) });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
