// One lesson through each coding CLI signed in on this computer (Claude
// Code, Codex, Grok, Kimi): the readiness probe, a pasted transcript through
// the job runner, schema validation with the quote checks, then that
// lesson's quiz and flashcards in the browser. No key is entered anywhere:
// the CLI's own sign-in is used, and the server runs with cloud keys blanked.
//
//   npm run harness:cli
//
// Environment:
//   HORNBOOK_CLI          comma list of claude, codex, grok, kimi; default: every one found on PATH
//   HORNBOOK_CLI_MODEL    model name handed to the CLI; default "-" (the model the CLI is set to)
//   HORNBOOK_BROWSER      playwright channel: chrome (default), msedge, chromium
//   CLAUDE_BIN, CODEX_BIN, GROK_BIN, KIMI_BIN   full path when a CLI is not on PATH
//
// Needs `npm run build` (the quiz walk serves dist/). A CLI that is not
// installed is SKIPped; one that is installed but does not answer is a FAIL.
// Lessons, job logs and screenshots land in work/harness/cli/<cli>/.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import type { ProbeResult } from '../src/lib/api-types.ts';
import { Lesson } from '../src/lib/schema.ts';
import { resolveCli } from '../scripts/lib/cli-path.ts';
import { isJunkQuoteText, quoteAppearsInTranscript } from '../scripts/lib/lesson-quality.ts';
import { CLI_BIN_ENV, CODING_CLIS, type CodingCliKind } from '../scripts/providers/cli-extract.ts';
import {
  Report,
  b64,
  client,
  fixturesDir,
  jobSummary,
  launchBrowser,
  obj,
  outDir,
  startServer,
  throwawayJournal,
  waitJob,
  type Api,
} from './lib.ts';

const PORT = Number(process.env['HORNBOOK_HARNESS_PORT'] ?? 8794);
const MODEL = process.env['HORNBOOK_CLI_MODEL']?.trim() || '-';
const JOB_TIMEOUT = 15 * 60 * 1000;
const transcript = join(fixturesDir, 'transcript.txt');
const shotsRoot = join(outDir, 'cli');

type QuizItem = {
  type: string;
  q?: string;
  options?: string[];
  answer?: number | string;
  answer_target?: string;
  auto_check?: boolean;
};

function wantedClis(): CodingCliKind[] {
  const list = process.env['HORNBOOK_CLI']?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list?.length) return [...CODING_CLIS];
  const known = CODING_CLIS as readonly string[];
  const bad = list.filter((k) => !known.includes(k));
  if (bad.length) throw new Error(`HORNBOOK_CLI: unknown CLI ${bad.join(', ')} (use ${CODING_CLIS.join(', ')})`);
  return list as CodingCliKind[];
}

function installed(kind: CodingCliKind): string | undefined {
  return resolveCli(process.env[CLI_BIN_ENV[kind]]?.trim() || kind, process.env);
}

function lessonShape(l: Record<string, unknown> | undefined): string {
  if (!l) return 'no lesson';
  const n = (k: string) => (Array.isArray(l[k]) ? (l[k] as unknown[]).length : 0);
  return `title="${String(l['title'])}" vocab=${n('vocabulary')} grammar=${n('grammar')} quiz=${n('quiz')} cards=${n('flashcards')} quotes=${n('quotes')}`;
}

async function takeQuiz(page: Page, quiz: QuizItem[], mode: 'right' | 'wrong') {
  const root = page.locator('app-quiz');
  await root.waitFor({ timeout: 15_000 });
  const items = root.locator('ol > li');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const li = items.nth(i);
    const q = quiz[i];
    if (!q) continue;
    if (q.type === 'mc') {
      const options = q.options ?? [];
      const idx = typeof q.answer === 'number' ? q.answer : 0;
      const pick = mode === 'right' ? options[idx] : (options.find((_, j) => j !== idx) ?? options[0]);
      if (pick) await li.getByText(pick, { exact: true }).click();
    } else if (q.type === 'fill') {
      const text = mode === 'right' && typeof q.answer === 'string' ? q.answer : 'WRONG';
      await li.locator('input[type=text]').fill(text);
    } else {
      const text = mode === 'right' && q.answer_target ? q.answer_target : 'nope';
      await li.locator('textarea').fill(text);
      if (!q.auto_check) {
        await li.getByRole('button', { name: /Show model answer/i }).click();
        const grade = mode === 'right' ? /Close enough/i : /Not this time/i;
        await li.getByRole('button', { name: grade }).click();
      }
    }
  }
  const check = root.getByRole('button', { name: 'Check', exact: true });
  await check.waitFor({ state: 'visible' });
  const enabled = await check.isEnabled();
  await check.click();
  await page.waitForTimeout(400);
  const body = await root.innerText();
  const score = body.match(/(\d+)\s*\/\s*(\d+)/);
  return { n, enabled, score: score?.[0] ?? null };
}

async function walkLesson(
  r: Report,
  kind: CodingCliKind,
  browser: Browser,
  base: string,
  slug: string,
  quiz: QuizItem[],
  shots: string,
): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await context.addInitScript(() => {
    localStorage.setItem('hornbook-locale', 'en');
    localStorage.setItem('hornbook-theme', 'day');
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/es-en/lesson/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('app-quiz').waitFor({ timeout: 15_000 });

    const wrong = await takeQuiz(page, quiz, 'wrong');
    r.rec(`${kind}: Check enables after every item is answered`, wrong.enabled, `questions=${wrong.n}`);
    r.rec(`${kind}: wrong answers score below perfect`, !!wrong.score && wrong.score !== `${wrong.n}/${wrong.n}`, wrong.score);
    await page.screenshot({ path: join(shots, 'quiz-wrong.png'), fullPage: true });

    await page.getByRole('button', { name: /^Again\b/ }).click();
    await page.waitForTimeout(300);
    const right = await takeQuiz(page, quiz, 'right');
    r.rec(`${kind}: correct answers grade perfect`, right.score === `${right.n}/${right.n}`, right.score);
    await page.screenshot({ path: join(shots, 'quiz-right.png'), fullPage: true });

    await page.goto(`${base}/es-en/flashcards?lesson=${slug}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const input = page.getByPlaceholder(/your answer/i);
    await input.waitFor({ timeout: 15_000 });
    const front = (await page.locator('div.font-display.text-3xl').first().innerText()).trim();
    r.rec(`${kind}: typing input is ready for a generated card`, front.length > 0, `front=${front}`);

    await input.fill('zzzz-wrong');
    await page.getByRole('button', { name: /^Check\b/ }).first().click();
    await page.waitForTimeout(400);
    const afterWrong = await page.locator('body').innerText();
    r.rec(`${kind}: nonsense answer is Wrong`, /Wrong/.test(afterWrong), afterWrong.match(/Wrong|Exact|Close/)?.[0] ?? '');
    const expected = afterWrong.match(/Correct:\s*(.+)/)?.[1]?.split('\n')[0]?.trim();
    r.rec(`${kind}: shows the expected answer`, !!expected, expected ?? '');

    await page.getByRole('button', { name: /reset/i }).click();
    await input.waitFor({ timeout: 5_000 });
    await input.fill(expected ?? '');
    await page.getByRole('button', { name: /^Check\b/ }).first().click();
    await page.waitForTimeout(400);
    const afterRight = await page.locator('body').innerText();
    r.rec(
      `${kind}: typing the expected answer is Exact or Close`,
      /Exact|Close/.test(afterRight) && !/✘ Wrong/.test(afterRight),
      afterRight.match(/Exact|Close|Wrong/)?.[0] ?? '',
    );
    await page.screenshot({ path: join(shots, 'cards.png'), fullPage: true });
  } finally {
    await context.close();
  }
}

async function oneCli(r: Report, kind: CodingCliKind, browser: Browser | undefined): Promise<void> {
  const shots = join(shotsRoot, kind);
  mkdirSync(shots, { recursive: true });
  const driver = `${kind}-cli`;
  const journal = throwawayJournal(`cli-${kind}`, {
    config: {
      brand: { name: `Hornbook ${kind}`, tagline: `${driver} extract` },
      providers: {
        transcribe: { driver: 'skip', model: '-' },
        extract: { driver, model: MODEL },
      },
      sections: [{ id: 'es-en', target: 'es', learner: 'en' }],
    },
  });
  const server = await startServer({ journal, port: PORT, serveStatic: !!browser });
  const api: Api = client(server.api);
  try {
    const probe = (await api('POST', '/api/settings/probe', { job: 'extract', driver, model: MODEL })).json as ProbeResult;
    r.rec(`${kind}: probe`, probe.ok === true, probe.detail);

    const posted = await api('POST', '/api/sections/es-en/uploads', {
      kind: 'process',
      filename: 'transcript.txt',
      base64: b64(transcript),
      date: '2026-09-04',
      from: 'transcript',
    });
    const id = obj(posted)['id'];
    if (typeof id !== 'string') {
      r.rec(`${kind}: process job queued`, false, posted.text.slice(0, 400));
      return;
    }
    const done = await waitJob(api, id, JOB_TIMEOUT);
    writeFileSync(join(shots, 'job-log.txt'), done?.log ?? posted.text, 'utf8');
    r.rec(`${kind}: transcript job finishes`, done?.status === 'done' && !!done.result?.slug, jobSummary(done));
    if (done?.status !== 'done' || !done.result?.slug) return;

    const slug = done.result.slug;
    const res = await api('GET', `/api/sections/es-en/lessons/${slug}`);
    const lesson = res.status === 200 ? obj(res) : undefined;
    writeFileSync(join(shots, 'lesson.json'), JSON.stringify(lesson, null, 2) + '\n');
    const parsed = Lesson.safeParse(lesson);
    r.rec(
      `${kind}: lesson validates with vocabulary, quiz and cards`,
      parsed.success &&
        parsed.data.vocabulary.length > 0 &&
        parsed.data.quiz.length > 0 &&
        parsed.data.flashcards.length > 0,
      lessonShape(lesson),
    );
    if (!parsed.success) return;

    const fixtureText = readFileSync(transcript, 'utf8');
    const junk = parsed.data.quotes.filter((q) => isJunkQuoteText(q.text));
    r.rec(`${kind}: quotes are not empty speaker labels`, junk.length === 0, junk.map((q) => q.text).join(' | '));
    const invented = parsed.data.quotes.filter((q) => !quoteAppearsInTranscript(q.text, fixtureText));
    r.rec(`${kind}: quotes that remain appear in the transcript`, invented.length === 0, invented.map((q) => q.text).join(' | '));

    if (parsed.data.quiz.length === 0) return;
    if (!browser) {
      r.skip(`${kind}: quiz and cards in the browser`, 'no Chrome or Edge could be launched');
      return;
    }
    await walkLesson(r, kind, browser, server.api, slug, parsed.data.quiz as QuizItem[], shots);
  } finally {
    server.stop();
  }
}

async function main(): Promise<void> {
  const r = new Report('cli-extract');
  mkdirSync(shotsRoot, { recursive: true });
  const kinds = wantedClis();

  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
  } catch (err) {
    r.note('info', 'no browser', String(err).split('\n')[0]);
  }

  try {
    for (const kind of kinds) {
      r.section(kind);
      const bin = installed(kind);
      if (!bin) {
        r.skip(`${kind}: installed`, `not on PATH (set ${CLI_BIN_ENV[kind]} to its full path)`);
        continue;
      }
      r.rec(`${kind}: installed`, true, bin);
      try {
        await oneCli(r, kind, browser);
      } catch (err) {
        r.rec(`${kind}: runner`, false, String(err));
      }
    }
  } finally {
    await browser?.close();
    r.finish();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
