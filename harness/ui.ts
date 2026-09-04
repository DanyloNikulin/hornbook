// Browser walk of the built app with Playwright driving the Chrome or Edge
// already installed (playwright-core: no browser download). Starts its own
// server on a throwaway copy of the demo journal, serving dist/, so run
// `npm run build` first. Screenshots land in work/harness/screens/.
//
//   npm run harness:ui
//
// Environment:
//   HORNBOOK_BROWSER   playwright channel: chrome (default), msedge, chromium
//   HORNBOOK_UI        walk an already running UI instead (e.g. http://localhost:4200,
//                      with HORNBOOK_API for its server, default http://127.0.0.1:8787);
//                      the throwaway pair it creates is removed through that API
//   OLLAMA_HOST        the "Find models" step expects a list when Ollama answers here

// The page.evaluate callbacks run inside the browser; the scripts tsconfig
// has no DOM lib, so pull it in for this file.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axe from 'axe-core';
import type { Browser } from 'playwright-core';
import type { JournalConfigT } from '../src/lib/journal-config.ts';
import { resolveCli } from '../scripts/lib/cli-path.ts';
import { Report, client, launchBrowser, obj, ollamaHostFromEnv, outDir, reachable, readJson, repoRoot, startServer, throwawayJournal, type ServerHandle } from './lib.ts';

const PORT = Number(process.env['HORNBOOK_HARNESS_PORT'] ?? 8796);
const SCREENS = join(outDir, 'screens');
const TEST = 'ja-en';

async function main(): Promise<void> {
  const r = new Report('ui');
  mkdirSync(SCREENS, { recursive: true });

  let base = process.env['HORNBOOK_UI'];
  let apiBase = process.env['HORNBOOK_API'] ?? 'http://127.0.0.1:8787';
  let server: ServerHandle | undefined;
  if (!base) {
    const dist = join(repoRoot, 'dist', 'hornbook', 'browser', 'index.html');
    if (!r.rec('dist/ is built', existsSync(dist), dist)) {
      r.note('info', 'Build first', 'npm run build');
      r.finish();
      return;
    }
    const journal = throwawayJournal('ui', { fromDemo: true });
    const configPath = join(journal, 'journal.config.json');
    const config = readJson<JournalConfigT>(configPath);
    // Keep the demo's extract model: the config schema needs a name, and the
    // button reads "Find models" until a list has arrived anyway.
    config.providers = { transcribe: { driver: 'skip', model: '-' }, extract: config.providers.extract };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    server = await startServer({ journal, port: PORT, serveStatic: true });
    base = server.api;
    apiBase = server.api;
    r.rec('throwaway server serves the build', true, base);
  }
  const api = client(apiBase);
  const ollamaUp = await reachable(`${ollamaHostFromEnv()}/api/tags`);

  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    r.rec('browser available', false, String(err));
    server?.stop();
    r.finish();
    return;
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  await context.addInitScript(() => {
    localStorage.setItem('hornbook-locale', 'en');
    localStorage.setItem('hornbook-theme', 'day');
    const state = window as Window & { __hornbookHidden?: boolean; __hornbookNotifications?: { title: string; body: string }[] };
    state.__hornbookHidden = false;
    state.__hornbookNotifications = [];
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.__hornbookHidden });
    } catch {
      // Reinstalled immediately before the notification check if needed.
    }
    try {
      const notification = Function(
        'title',
        'options',
        'window.__hornbookNotifications.push({ title, body: options && options.body || "" })',
      ) as unknown as typeof Notification;
      Object.defineProperty(notification, 'permission', { value: 'granted' });
      Object.defineProperty(notification, 'requestPermission', {
        value: Function('return Promise.resolve("granted")'),
      });
      Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
    } catch {
      // Reinstalled immediately before the notification check if needed.
    }
  });
  const page = await context.newPage();
  await page.route('**/__harness/axe.js', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: axe.source });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  const shot = async (name: string) => page.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: true });
  const goto = (path: string) => page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const seen = async (text: string | RegExp, timeout = 10_000) => {
    const loc = page.getByText(text, { exact: false }).first();
    await loc.waitFor({ state: 'visible', timeout });
    return loc;
  };
  const body = () => page.locator('body').innerText();
  const axeViolations = async () => {
    await page.addScriptTag({ url: `${base}/__harness/axe.js` });
    return page.evaluate(async () => {
      const api = (window as unknown as Window & {
        axe: {
          run: (root: Document, options: unknown) => Promise<{
            violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[];
          }>;
        };
      }).axe;
      const result = await api.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
      });
      return result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
      }));
    });
  };

  try {
    r.section('home + setup');
    const firstRunPage = await context.newPage();
    await firstRunPage.route('**/api/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          brand: { name: 'Hornbook', tagline: 'conspects from your lessons' },
          providers: {
            transcribe: { driver: 'skip', model: '-' },
            extract: { driver: 'ollama', model: 'qwen2.5:7b' },
          },
          sections: [],
        }),
      });
    });
    await firstRunPage.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const newJournalState = firstRunPage.locator('.il-empty-state--journal');
    await newJournalState.waitFor({ state: 'visible', timeout: 10_000 });
    r.rec(
      'new journal points straight at its first pair',
      /No pairs yet/.test(await newJournalState.innerText()) &&
        (await newJournalState.getByRole('link', { name: /Create the first pair/i }).getAttribute('href')) === '/setup',
    );
    await firstRunPage.screenshot({ path: join(SCREENS, '00-empty-journal.png'), fullPage: true });
    await firstRunPage.close();

    await goto('/');
    await seen('Language pairs');
    await seen('Spanish');
    await seen('Italian');
    r.rec('home lists both demo pairs', (await page.locator('.il-section-card').count()) >= 2);
    await page.keyboard.press('Tab');
    const skipLink = page.locator('.il-skip-link');
    const skipVisible = await skipLink.isVisible();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    r.rec(
      'skip link moves keyboard focus to the main content',
      skipVisible && (await page.evaluate(() => document.activeElement?.id)) === 'main-content',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedDuration = await page.locator('.il-theme-btn').first().evaluate((element) => getComputedStyle(element).transitionDuration);
    r.rec('reduced-motion preference removes decorative transitions', Number.parseFloat(reducedDuration) <= 0.001, reducedDuration);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const flagFont = await page.evaluate(async () => {
      await document.fonts.load('28px "Twemoji Country Flags"', '\u{1F1EA}\u{1F1F8}');
      const face = [...document.fonts].find((f) => f.family.replace(/"/g, '') === 'Twemoji Country Flags');
      return { status: face?.status ?? 'missing', check: document.fonts.check('28px "Twemoji Country Flags"', '\u{1F1EA}\u{1F1F8}') };
    });
    r.rec('bundled flag font loads (Windows shows flags, not "ES")', flagFont.status === 'loaded' && flagFont.check, JSON.stringify(flagFont));
    const flagFamily = await page.locator('.il-section-flags').first().evaluate((el) => getComputedStyle(el).fontFamily);
    r.rec('flag elements ask for the flag font first', /Twemoji Country Flags/.test(flagFamily), flagFamily);
    await shot('01-home');

    await page.getByRole('link', { name: /New pair/i }).first().click();
    await seen('New language pair');
    r.rec('setup catalogue has the bundled languages', (await page.locator('.il-lang-option').count()) > 40);
    await shot('02-setup');

    r.section('application settings');
    await goto('/settings');
    await seen('Application');
    await seen('Interface');
    await shot('03-settings-en');
    await page.getByRole('radio', { name: /Italiano/i }).click();
    await page.waitForTimeout(400);
    r.rec('interface switches to Italian', /Interfaccia/.test(await body()));
    await shot('04-settings-it');
    await page.getByRole('radio', { name: /English/i }).click();
    await seen('Interface');

    const hear = page.locator('.il-pipe').nth(0);
    const chips = hear.locator('[role=radiogroup] .il-chip');
    r.rec('hearing offers three places', (await chips.count()) >= 3, (await chips.allInnerTexts()).join(' | '));
    await chips.filter({ hasText: /paste the text/i }).click();
    await hear.getByRole('button', { name: /Check this step|Find models/i }).click();
    const hearResult = hear.locator('.il-pipe-result');
    await hearResult.waitFor({ state: 'visible', timeout: 20_000 });
    r.rec('skip-hearing probe is green', (await hearResult.getAttribute('class'))?.includes('il-pipe-result--ok') === true, await hearResult.innerText().catch(() => ''));

    // Probes answer within the server's 8 s timeout; a busy Ollama can use all of it.
    const write = page.locator('.il-pipe').nth(1);
    await write.locator('[role=radiogroup] .il-chip').filter({ hasText: /Home network/i }).click();
    await write.getByRole('button', { name: /Find models/i }).click();
    const writeResult = write.locator('.il-pipe-result');
    await writeResult.waitFor({ state: 'visible', timeout: 30_000 });
    const writeClass = (await writeResult.getAttribute('class')) ?? '';
    const writeText = await writeResult.innerText().catch(() => '');
    if (ollamaUp) {
      const picker = write.locator('.il-model-picker');
      if ((await picker.locator('.il-model-picker-popover').count()) === 0) {
        await picker.locator('.il-model-picker-trigger').click();
      }
      const modelOptions = picker.locator('.il-model-option');
      const models = (await modelOptions.allInnerTexts()).map((model) => model.trim());
      const sortedModels = [...models].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      r.rec('Find models opens a sorted dropdown and is not painted red', writeClass.includes('il-pipe-result--pick') && !writeClass.includes('il-pipe-result--bad') && models.length > 0 && /Connected\./.test(writeText) && models.join('|') === sortedModels.join('|'), `${writeText} | ${models.join(', ')}`);
      r.rec('no model is chosen for the user', /Choose a model/i.test(await picker.locator('.il-model-picker-trigger').innerText()));
      const searchModels = picker.locator('.il-model-search');
      await searchModels.fill('qwen');
      const filteredModels = (await modelOptions.allInnerTexts()).map((model) => model.trim());
      r.rec('model dropdown filters while typing', filteredModels.length > 0 && filteredModels.every((model) => /qwen/i.test(model)), filteredModels.join(', '));
      await shot('05-settings-probe');
      await modelOptions.first().click();
      await write.getByRole('button', { name: /Check this step/i }).click();
      await writeResult.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
      await writeResult.waitFor({ state: 'visible', timeout: 30_000 });
      const after = (await writeResult.getAttribute('class')) ?? '';
      r.rec('a picked model checks green', after.includes('il-pipe-result--ok'), await writeResult.innerText().catch(() => ''));
    } else {
      r.rec('Find models without Ollama is a red "Not yet."', writeClass.includes('il-pipe-result--bad') && /Not yet\./.test(writeText), writeText);
      r.skip('Find models lists pulled models', 'no Ollama reachable');
      await shot('05-settings-probe');
    }

    // Writing on this computer: the coding CLIs. The probe only knows whether
    // the CLI is installed, so an installed one reads green with the file it
    // resolved to and a missing one is a red "Not yet.".
    await write.locator('[role=radiogroup] .il-chip').filter({ hasText: /This computer/i }).first().click();
    const cliGroup = write.locator('.il-cli-list');
    await cliGroup.locator('.il-cli-option').first().waitFor({ timeout: 5_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.il-cli-list .il-cli-status').length === 4 &&
        ![...document.querySelectorAll('.il-cli-list .il-cli-status')].some((el) => /Checking/.test(el.textContent ?? '')),
      undefined,
      { timeout: 20_000 },
    );
    const cliNames = (await cliGroup.locator('.il-cli-pick').allInnerTexts()).map((s) => s.trim());
    r.rec('writing on this computer offers the four coding CLIs', cliNames.join('|') === 'Claude Code|Codex|Grok|Kimi', cliNames.join(' | '));
    r.rec('Grok and Kimi are marked experimental', (await cliGroup.locator('.il-cli-experimental').count()) === 2);
    r.rec('all four CLIs show an installed or missing status', (await cliGroup.locator('.il-cli-status--ok, .il-cli-status--bad').count()) === 4);
    r.rec('the model field explains the CLI default "-"', (await write.locator('input[type=text]').last().inputValue()) === '-' && /does not override the model/i.test(await write.locator('.il-cli-default-note').innerText()));
    const codex = cliGroup.locator('.il-cli-option').filter({ hasText: 'Codex' }).first();
    const codexBin = resolveCli(process.env['CODEX_BIN']?.trim() || 'codex', process.env);
    if (codexBin) {
      r.rec('Codex status is installed before it is selected', (await codex.locator('.il-cli-status--ok').count()) === 1, await codex.innerText());
      await codex.locator('.il-cli-pick').click();
      await write.getByRole('button', { name: /Check this step/i }).click();
      await writeResult.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
      await writeResult.waitFor({ state: 'visible', timeout: 30_000 });
      const cliClass = (await writeResult.getAttribute('class')) ?? '';
      const cliText = await writeResult.innerText().catch(() => '');
      r.rec('Codex on PATH checks green with the file it resolved to', cliClass.includes('il-pipe-result--ok') && /codex/i.test(cliText), cliText);
    } else {
      r.rec('Codex missing from PATH is grey with an install line', (await codex.locator('.il-cli-status--bad').count()) === 1 && /CODEX_BIN/.test(await codex.innerText()), await codex.innerText());
      r.skip('Codex on PATH checks green with the file it resolved to', 'Codex is not installed');
    }
    await shot('05b-settings-cli');

    // Local tools: the five rows and the one button. A plan (source, size,
    // checksum) is shown before any download; this walk fetches nothing.
    const toolRows = page.locator('.il-setup-row');
    r.rec('local tools list the five rows', (await toolRows.count()) === 5, `n=${await toolRows.count()}`);
    const setupAll = page.locator('button').filter({ hasText: /Set up everything|Setting up|Prepara tutto|Preparazione/ }).first();
    r.rec('the one setup button is there', (await setupAll.count()) === 1);
    if (await reachable('https://huggingface.co/', 4000)) {
      const modelRow = page.locator('.il-setup-row[data-tool="whisper-model"]');
      await modelRow.getByRole('button', { name: /^(Download|Scarica)/ }).click();
      const plan = modelRow.locator('.il-setup-plan');
      await plan.filter({ hasText: /SHA-256/ }).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      const planText = (await plan.first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      r.rec('a download shows source, size and checksum before it starts', /SHA-256/.test(planText) && /MB/.test(planText), planText.slice(0, 140));
      await shot('05c-settings-tools-plan');
      await modelRow.getByRole('button', { name: /^(Cancel|Annulla)/ }).click();
      await plan.first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
      r.rec('cancel puts the row back without fetching', (await plan.count()) === 0);
    } else {
      r.skip('download plan on the setup page', 'huggingface.co not reachable');
    }

    r.section('Spanish pair');
    await goto('/es-en');
    await seen('Saludos');
    await shot('06-es-lessons');
    await goto('/es-en/lesson/fin-de-semana-preterito');
    await seen('Takeaway');
    r.rec('lesson article renders', (await page.locator('.il-lesson-article').count()) > 0);
    r.rec('glossary cards render', (await page.locator('.il-vocab-card').count()) >= 3);
    const lessonRail = page.locator('.il-lesson-rail');
    r.rec('lesson page has the sticky section rail', await lessonRail.isVisible());
    r.rec('lesson number counts from the oldest lesson', /lesson 2/i.test(await page.locator('.il-lesson-num').innerText()));
    r.rec(
      'lesson renders extracted slides and their tables',
      (await page.locator('.il-slide-card').count()) === 2 && (await page.locator('.il-slide-table').count()) === 2,
    );
    const axeIssues = await axeViolations();
    r.rec(
      'lesson page passes the automated WCAG 2.2 AA scan',
      axeIssues.length === 0,
      axeIssues.map((issue) => `${issue.id} (${issue.impact}): ${issue.targets.join(', ')}`).join(' | '),
    );
    const lessonCardsHref = (await page.locator('.il-lesson-actions a').filter({ hasText: /Study this lesson/i }).getAttribute('href')) ?? '';
    r.rec('lesson card action opens the whole lesson deck', /lesson=fin-de-semana-preterito/.test(lessonCardsHref) && !/mini=/.test(lessonCardsHref), lessonCardsHref);
    const slidesJump = lessonRail.getByRole('link', { name: /slides/i });
    await slidesJump.click();
    await page.waitForTimeout(200);
    const slidesTop = await page.locator('#lesson-slides').evaluate((el) => el.getBoundingClientRect().top);
    r.rec(
      'lesson rail jump links reach their section',
      page.url().endsWith('/es-en/lesson/fin-de-semana-preterito#lesson-slides') && slidesTop >= 0 && slidesTop < 140,
      `${page.url()} top=${Math.round(slidesTop)}`,
    );
    await shot('07-es-lesson');

    const quiz = page.locator('app-quiz');
    await quiz.waitFor({ timeout: 10_000 });
    const items = quiz.locator('ol > li');
    const n = await items.count();
    const keyboardChoice = quiz.locator('input[type=radio]').first();
    await keyboardChoice.focus();
    await page.keyboard.press('Space');
    let translations = 0;
    for (let i = 0; i < n; i++) {
      const li = items.nth(i);
      const kind = await li.getAttribute('data-quiz-type');
      if (kind === 'mc') {
        await li.locator('input[type=radio]').first().check();
      } else if (kind === 'fill') {
        await li.locator('input[type=text]').fill('x');
      } else {
        translations++;
        await li.locator('textarea').fill('hola');
      }
    }
    const check = quiz.getByRole('button', { name: 'Check', exact: true });
    await check.waitFor({ state: 'visible', timeout: 10_000 });
    r.rec('quiz Check is available before translation self-grading', await check.isEnabled() && (await quiz.locator('.il-quiz-model-answer').count()) === 0);
    await check.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    r.rec('quiz answer and Check work from the keyboard', await keyboardChoice.isChecked() && (await quiz.locator('.il-quiz-model-answer').count()) > 0);
    const pendingAfterCheck = await quiz.locator('.il-quiz-item--open').count();
    r.rec(
      'quiz Check grades objective answers and reveals every translation',
      (await quiz.locator('.il-quiz-item--right, .il-quiz-item--wrong').count()) === n - pendingAfterCheck &&
        (await quiz.locator('.il-quiz-model-answer').count()) === pendingAfterCheck,
      `questions=${n} translations=${translations} pending=${pendingAfterCheck}`,
    );
    const saveScore = quiz.getByRole('button', { name: /^Save score/i });
    r.rec(
      'quiz gives the disabled Save score action a visible reason',
      translations === 0 || (!(await saveScore.isEnabled()) && /translation.*left to grade/i.test(await saveScore.innerText())),
    );
    for (let i = 0; i < n; i++) {
      const li = items.nth(i);
      if ((await li.getAttribute('data-quiz-type')) !== 'translate') continue;
      const closeEnough = li.getByRole('button', { name: /Close enough/i });
      if (await closeEnough.count()) await closeEnough.click();
    }
    await page.waitForTimeout(100);
    r.rec('quiz Save score enables once every translation is graded', await saveScore.isEnabled());
    await saveScore.click();
    await page.waitForTimeout(300);
    const score = (await quiz.innerText()).match(/\d+\s*\/\s*\d+/)?.[0];
    r.rec('quiz saves and shows the final score', !!score, score);
    await shot('08-es-quiz');

    const topic = page.locator('.il-topic-chip').first();
    if (await topic.count()) {
      await topic.click();
      await page.waitForTimeout(500);
      r.rec('topic chip filters the lesson list', (await page.locator('.il-filter-bar, .il-filter-value').count()) > 0, page.url());
    }

    const largeVocab = Array.from({ length: 733 }, (_, index) => {
      const letter = String.fromCharCode(97 + (index % 26));
      const target = index === 0 ? 'hola' : index === 1 ? 'gusto' : `${letter} parola ${String(index + 1).padStart(3, '0')}`;
      return {
        target,
        learner: index === 0 ? 'hello' : index === 1 ? 'taste' : `word ${index + 1}`,
        level: ['A1', 'A2', 'B1', 'B2'][index % 4],
        example_target: `Esempio per ${target}.`,
        example_learner: `Example for ${target}.`,
        first_seen: 'lesson-one',
        first_seen_date: '2026-09-04',
        seen_in: index % 3 === 0 ? ['lesson-one', 'lesson-two'] : ['lesson-one'],
      };
    });
    await page.route('**/api/sections/es-en/vocab', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(largeVocab) });
    });
    await goto('/es-en/vocab');
    await page.locator('.il-vocab-row').first().waitFor({ timeout: 10_000 });
    r.rec('large glossary uses a counted alphabet index', (await page.locator('.il-vocab-letter').count()) === 28 && /733 words/.test(await page.locator('.il-vocab-title-row').innerText()));
    r.rec('large glossary keeps fifty entries per page', (await page.locator('.il-vocab-row').count()) === 50 && /1–50 of 733/.test(await page.locator('.il-vocab-pagination').innerText()));
    const letterA = page.locator('.il-vocab-letter:not(.il-vocab-letter--all)').filter({ hasText: /^A/ }).first();
    await letterA.click();
    await page.waitForTimeout(100);
    const aWords = await page.locator('.il-vocab-word > span:first-child').allInnerTexts();
    r.rec('letter index filters directly to that part of the glossary', aWords.length > 0 && aWords.every((word) => /^[aàáâä]/i.test(word)), `${aWords.length} A words`);
    await letterA.click();
    await shot('09-es-glossary');
    await page.getByPlaceholder(/Search/i).first().fill('gusto');
    await page.waitForTimeout(300);
    r.rec('glossary search narrows the list', /gusto/i.test(await body()) && !/^\s*$/.test(await body()));

    await goto('/es-en/flashcards?lesson=fin-de-semana-preterito');
    await seen('Flashcards');
    const deckSelect = page.locator('.il-cards-deck-select select');
    await page.locator('.il-study-card').waitFor({ timeout: 10_000 });
    const selectedDeck = await deckSelect.locator('option:checked').innerText();
    const deckStats = await page.locator('.il-cards-deck-stats').innerText();
    const deckSize = Number(deckStats.match(/^\d+/)?.[0] ?? 0);
    r.rec(
      'Cards lesson filter names the active lesson and its card count',
      /This lesson.*fin de semana/i.test(selectedDeck) && deckSize > 10,
      `${selectedDeck} | ${deckStats}`,
    );
    r.rec(
      'lesson deck explains its one-pass rule',
      /start to finish.*daily limit.*All cards/i.test(await page.locator('.il-cards-deck-help').innerText()),
    );
    for (let i = 0; i < 10; i++) {
      await page.getByRole('button', { name: /^skip$/i }).click();
      await page.waitForFunction(
        (expected) => Number(document.querySelector('.il-study-card-meta')?.textContent?.match(/\d+/)?.[0]) === expected,
        i + 2,
        { timeout: 2_000 },
      );
    }
    const cardProgress = await page.locator('.il-study-card-meta').innerText();
    const cardNumbers = cardProgress.match(/\d+/g)?.map(Number) ?? [];
    r.rec(
      'lesson deck continues past the ten-card daily limit',
      cardNumbers[0] === 11 && cardNumbers[1] === deckSize,
      cardProgress,
    );
    await deckSelect.selectOption('greetings');
    await page.waitForURL(/\/es-en\/flashcards\?lesson=greetings$/);
    await page.locator('.il-study-card').waitFor({ timeout: 10_000 });
    const switchedDeckStats = await page.locator('.il-cards-deck-stats').innerText();
    const switchedDeckSize = Number(switchedDeckStats.match(/^\d+/)?.[0] ?? 0);
    const switchedSource = await page.locator('.il-study-source').innerText();
    r.rec(
      'deck selector switches to that lesson’s cards without leaving Cards',
      /This lesson.*Saludos/i.test(await deckSelect.locator('option:checked').innerText()) &&
        switchedDeckSize > 0 && switchedDeckSize !== deckSize && /greetings/i.test(switchedSource),
      `${page.url()} | ${switchedDeckStats} | ${switchedSource}`,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const cardsPageFits = await page.locator('.il-cards-page').evaluate(
      (el) => el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    r.rec('Cards deck controls fit a phone viewport', cardsPageFits);
    const levelRowSizes = await page.locator('.il-cards-filter-group--levels .il-chip').evaluateAll((buttons) => {
      const rows = new Map<number, number>();
      for (const button of buttons) {
        const top = Math.round(button.getBoundingClientRect().top);
        rows.set(top, (rows.get(top) ?? 0) + 1);
      }
      return [...rows.values()];
    });
    r.rec('Cards level filters wrap as a balanced group', levelRowSizes.join('|') === '4|3', levelRowSizes.join(' + '));
    r.rec(
      'phone Sheet action sits in the header instead of over the cards',
      await page.locator('.il-mobile-sheet').isVisible() && !(await page.locator('.il-fab').isVisible()),
    );
    await shot('10a-es-cards-mobile');
    await page.setViewportSize({ width: 1280, height: 800 });

    await goto('/es-en/flashcards');
    await seen(/Cards|Flashcards/);
    const typeInput = page.getByPlaceholder(/your answer/i);
    if (await typeInput.count()) {
      await typeInput.focus();
      await page.keyboard.type('zzzz-wrong');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      r.rec('flashcards grade a typed answer from the keyboard', /Wrong|Correct:/.test(await body()));
    } else {
      r.skip('flashcards grade a typed answer from the keyboard', 'no typing input on the first card');
    }
    await shot('10-es-cards');

    await goto('/es-en/search');
    await page.locator('input[type=search]').first().fill('hola');
    await page.waitForTimeout(800);
    r.rec('search finds hola', /hola/i.test(await body()) && !/Nothing for/i.test(await body()));
    await shot('11-es-search');

    const cheatFixture = {
      processed_lessons: Array.from({ length: 33 }, (_, index) => `lesson-${index + 1}`),
      updated_at: '2026-09-04T12:00:00.000Z',
      categories: [
        {
          id: 'tenses',
          title: 'Tenses',
          sections: [
            {
              id: 'present-tense',
              title: 'Present tense',
              main_table: [['person', '-are'], ['io', 'parlo'], ['tu', 'parli']],
              exception_tables: [],
              notes: ['Use the present for habits and facts.'],
              source_lessons: ['greetings'],
            },
            {
              id: 'passato-prossimo',
              title: 'Passato prossimo',
              main_table: [['person', 'avere + participle', 'essere + participle'], ['io', 'ho parlato', 'sono andato/a'], ['tu', 'hai parlato', 'sei andato/a']],
              exception_tables: [{ title: 'Irregular participles', table: [['fare', 'dire'], ['fatto', 'detto']] }],
              notes: ['Movement and change of state usually take essere.'],
              source_lessons: ['fin-de-semana-preterito'],
            },
          ],
        },
        {
          id: 'verbs',
          title: 'Verbs',
          sections: [
            { id: 'modal-verbs', title: 'Modal verbs', main_table: [['verb', 'meaning'], ['potere', 'can']], exception_tables: [], notes: [], source_lessons: ['greetings'] },
            { id: 'reflexive-verbs', title: 'Reflexive verbs', exception_tables: [], notes: ['The pronoun changes with the subject.'], source_lessons: [] },
          ],
        },
      ],
    };
    await page.route('**/api/sections/es-en/cheatsheet', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cheatFixture) });
    });
    await goto('/es-en/cheatsheet');
    await seen('Cheatsheet');
    const sheetRail = page.locator('.il-sheet-rail');
    r.rec('cheat sheet has a grouped section rail', await sheetRail.isVisible() && (await sheetRail.locator('.il-sheet-rail-link').count()) === 4);
    const railSearch = sheetRail.locator('input[type=search]');
    await railSearch.fill('modal');
    r.rec('cheat sheet rail finds a section by name', (await sheetRail.locator('.il-sheet-rail-link').count()) === 1 && /Modal verbs/.test(await sheetRail.innerText()));
    await railSearch.fill('');
    const pastLink = sheetRail.getByRole('link', { name: 'Passato prossimo' });
    await pastLink.click();
    await page.waitForTimeout(150);
    const sheetTop = await page.locator('#sheet-tenses-passato-prossimo').evaluate((element) => element.getBoundingClientRect().top);
    r.rec('cheat sheet rail jumps to the selected section', page.url().endsWith('#sheet-tenses-passato-prossimo') && sheetTop >= 0 && sheetTop < 140, `${page.url()} top=${Math.round(sheetTop)}`);
    r.rec('Sheet shortcut stays off the Cheat Sheet content', (await page.locator('.il-fab').count()) === 0);
    await shot('11b-es-cheatsheet');
    await goto('/es-en/compose');
    await seen('Add a conspect');
    const composeTabs = page.getByRole('tab');
    r.rec('Add presents three input tabs', (await composeTabs.count()) === 3, `n=${await composeTabs.count()}`);
    const setupState = page.locator('.il-compose-setup-state');
    r.rec(
      'pipeline-not-ready state points at Local tools',
      await setupState.isVisible() &&
        /Recordings need hearing/.test(await setupState.innerText()) &&
        /\/es-en\/application#local-tools$/.test((await setupState.getByRole('link').getAttribute('href')) ?? ''),
    );
    await page.locator('.il-compose-dropzone input[type=file]').setInputFiles(join(repoRoot, 'harness', 'fixtures', 'transcript.txt'));
    await seen('transcript.txt');
    r.rec('file choice shows all five preflight stages', (await page.locator('.il-compose-steps li').count()) === 5);
    r.rec('file choice waits for Start', (await page.locator('.il-job').count()) === 0 && /Ready\. This is what Start will do/.test(await body()));
    await shot('12-es-compose');

    const jobStart = new Date(Date.now() - 72_000).toISOString();
    const writingStart = new Date(Date.now() - 24_000).toISOString();
    const fakeStages = [
      { id: 'hearing', status: 'skipped', startedAt: jobStart, finishedAt: jobStart },
      { id: 'slides', status: 'skipped', startedAt: jobStart, finishedAt: jobStart },
      { id: 'writing', status: 'running', startedAt: writingStart },
      { id: 'checking', status: 'waiting' },
    ];
    const fakeBase = {
      id: 'harness-job',
      section: 'es-en',
      kind: 'process',
      label: 'transcript.txt',
      createdAt: jobStart,
      startedAt: jobStart,
    };
    let fakePolls = 0;
    const postRoute = '**/api/sections/es-en/jobs';
    const getRoute = '**/api/jobs/harness-job';
    await page.route(postRoute, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...fakeBase, status: 'queued', log: '', stages: fakeStages }),
      });
    });
    await page.route(getRoute, async (route) => {
      fakePolls++;
      const done = fakePolls >= 5;
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...fakeBase,
          status: done ? 'done' : 'running',
          log: done ? 'write  lesson valid\ncheck  schema valid\nsave   ready' : 'write  waiting for the model…',
          ...(done ? { finishedAt: now } : {}),
          stages: done
            ? fakeStages.map((stage) => ({
                ...stage,
                status: stage.status === 'running' ? 'done' : stage.status === 'waiting' ? 'done' : stage.status,
                finishedAt: stage.finishedAt ?? now,
              }))
            : fakeStages,
        }),
      });
    });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('.il-job-stage--running').waitFor({ timeout: 5_000 });
    r.rec('running job shows the four named stages', (await page.locator('.il-job-stage').count()) === 4 && /Hearing.*Slides.*Writing.*Checking/s.test(await page.locator('.il-job-stages').innerText()));
    r.rec('running job shows elapsed time and a live log', /\d+:\d{2}.*elapsed/.test(await page.locator('.il-job-time').innerText()) && /waiting for the model/i.test(await page.locator('.il-job .il-log').innerText()));
    r.rec('job progress distinguishes skipped, active and waiting stages', (await page.locator('.il-job-stage--skipped').count()) === 2 && (await page.locator('.il-job-stage--running').count()) === 1 && (await page.locator('.il-job-stage--waiting').count()) === 1);
    await page.evaluate(() => {
      (window as Window & { __hornbookHidden?: boolean }).__hornbookHidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    });
    await shot('12b-es-job-running');
    await page.locator('.il-job--done').waitFor({ timeout: 8_000 });
    const notificationState = await page.evaluate(() => ({
      hidden: document.hidden,
      permission: typeof Notification === 'undefined' ? 'missing' : Notification.permission,
      notifications: (window as Window & { __hornbookNotifications?: { title: string; body: string }[] }).__hornbookNotifications ?? [],
    }));
    r.rec(
      'background completion sends a browser notification',
      notificationState.notifications.some((item) => /Hornbook job finished/.test(item.title) && /transcript\.txt is ready/.test(item.body)),
      JSON.stringify(notificationState),
    );
    r.rec('finished job keeps its final log visible', /schema valid/.test(await page.locator('.il-job .il-log').innerText()) && (await page.locator('.il-job-stage--done').count()) === 2);
    await page.evaluate(() => {
      (window as Window & { __hornbookHidden?: boolean }).__hornbookHidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    });
    await shot('12c-es-job-done');
    await page.unroute(postRoute);
    await page.unroute(getRoute);

    await goto('/es-en/settings');
    await seen('This pair');
    const presets = page.locator('.il-preset');
    r.rec('pair settings show the theme presets', (await presets.count()) >= 6, `n=${await presets.count()}`);
    await presets.nth(2).click();
    await page.waitForTimeout(300);
    await shot('13-es-pair-settings');

    r.section('Italian pair + routing');
    await goto('/it-en');
    await seen('Saluti');
    await page.getByRole('link', { name: /Saluti/i }).first().click();
    await seen('Ciao');
    r.rec('Italian lesson opens', true);
    const sw = page.locator('select.il-section-switch');
    if (await sw.count()) {
      await sw.selectOption('es-en');
      await page.waitForTimeout(800);
      r.rec('pair switcher lands on the other pair', page.url().includes('/es-en'), page.url());
    }
    await goto('/es-en/no-such-page');
    await seen('Page not found');
    const nfSearch = page.getByRole('main').getByRole('link', { name: /^Search$/i });
    if (await nfSearch.count()) {
      await nfSearch.click();
      await page.waitForTimeout(800);
      r.rec('in-pair 404 links to that pair’s search', /\/es-en\/search(\?|$)/.test(page.url()), page.url());
    }
    await goto('/zz-zz');
    await page.waitForTimeout(600);
    r.rec('unknown pair shows not-found at its own URL', /\/zz-zz$/.test(page.url()) && /Page not found/.test(await body()), page.url());

    await goto('/');
    const before = await page.locator('html').getAttribute('data-theme');
    await page.locator('.il-nav-links .il-theme-btn').click();
    await page.waitForTimeout(200);
    const after = await page.locator('html').getAttribute('data-theme');
    r.rec('day/night toggle', before !== after && !!after, `${before} → ${after}`);
    await shot('14-night');

    r.section('create a pair and a lesson by hand');
    await goto('/setup');
    const cols = page.locator('.il-pair-col');
    await cols.nth(0).locator('.il-lang-option').filter({ has: page.locator('.il-lang-name', { hasText: /^Japanese$/ }) }).click();
    await cols.nth(1).locator('.il-lang-option').filter({ has: page.locator('.il-lang-name', { hasText: /^English$/ }) }).click();
    await page.getByPlaceholder(/e\.g\. Italian/i).fill('Harness UI pair');
    await page.getByRole('button', { name: /Create pair/i }).click();
    await page.waitForURL(/\/ja-en/, { timeout: 10_000 });
    r.rec(`UI creates ${TEST}`, page.url().includes(`/${TEST}`), page.url());
    const emptyPairState = page.locator('.il-empty-state--lessons');
    await emptyPairState.waitFor({ state: 'visible', timeout: 10_000 });
    const addFirst = emptyPairState.getByRole('link', { name: /Add the first conspect/i });
    r.rec(
      'empty pair points straight at its first lesson',
      /No lessons yet/.test(await emptyPairState.innerText()) && (await addFirst.getAttribute('href')) === `/${TEST}/compose`,
    );
    await shot('15a-empty-pair');
    await addFirst.click();
    await page.waitForURL(new RegExp(`/${TEST}/compose$`), { timeout: 10_000 });
    await page.getByRole('tab', { name: /By hand/i }).click();
    await page.getByPlaceholder('Greetings').fill('Hiragana smoke');
    await page.locator('textarea').nth(0).fill('A one-line summary for the UI harness.');
    await page.locator('textarea').nth(1).fill('## Takeaway\n\nJust checking the save path.\n');
    await page.getByRole('button', { name: /Save lesson/i }).click();
    await page.waitForURL(/\/lesson\//, { timeout: 10_000 });
    r.rec('UI saves a hand-written lesson', /hiragana-smoke/.test(page.url()), page.url());
    await shot('15-ja-lesson');

    r.section('mobile');
    await page.setViewportSize({ width: 390, height: 844 });
    await goto('/es-en');
    await page.getByRole('heading', { name: 'All lessons' }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(100);
    const burger = page.locator('.il-hamburger');
    r.rec('mobile hamburger visible', await burger.isVisible());
    await burger.click();
    await page.waitForTimeout(300);
    const mobileMenu = page.locator('.il-mobile-menu');
    r.rec('mobile menu opens', await mobileMenu.isVisible());
    const pairRows = mobileMenu.locator('.il-mobile-pair');
    const pairText = await pairRows.allInnerTexts();
    r.rec(
      'mobile drawer gives every pair a readable entry',
      pairText.length === 3 && pairText.every((text) => /[A-Z]{2}-[A-Z]{2}/.test(text)) &&
        (await mobileMenu.locator('.il-mobile-pair[aria-current=true]').count()) === 1 && /current/i.test(pairText.join(' ')),
      pairText.join(' | '),
    );
    await shot('16-mobile-menu');
    await mobileMenu.getByRole('link', { name: /Glossary/i }).click();
    await page.waitForTimeout(600);
    r.rec('mobile nav reaches the glossary', page.url().includes('/vocab'), page.url());

    const real = pageErrors.filter((e) => !/favicon/i.test(e));
    r.rec('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));
  } catch (err) {
    r.rec('harness runner', false, String(err));
    await shot('zz-crash').catch(() => undefined);
  } finally {
    await browser.close();
    if (server) {
      server.stop();
    } else {
      // Foreign server: take the throwaway pair away again (lessons first).
      const lessons = await api('GET', `/api/sections/${TEST}/lessons`);
      if (Array.isArray(lessons.json)) {
        for (const meta of lessons.json as { slug: string }[]) await api('DELETE', `/api/sections/${TEST}/lessons/${meta.slug}`);
      }
      const gone = await api('DELETE', `/api/sections/${TEST}`);
      r.rec(`cleanup ${TEST} on the running server`, gone.status === 200 || gone.status === 404, String(obj(gone)['error'] ?? gone.status));
    }
  }
  r.finish({ base, screens: SCREENS });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
