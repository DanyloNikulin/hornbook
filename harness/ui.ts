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
  });
  const page = await context.newPage();
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

  try {
    r.section('home + setup');
    await goto('/');
    await seen('Language pairs');
    await seen('Spanish');
    await seen('Italian');
    r.rec('home lists both demo pairs', (await page.locator('.il-section-card').count()) >= 2);
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
    const models = await write.locator('.il-pipe-models .il-chip').allInnerTexts();
    if (ollamaUp) {
      r.rec('Find models lists pulled models and is not painted red', writeClass.includes('il-pipe-result--pick') && !writeClass.includes('il-pipe-result--bad') && models.length > 0 && /Connected\./.test(writeText), `${writeText} | ${models.join(', ')}`);
      r.rec('no model is chosen for the user', (await write.locator('.il-pipe-models .il-chip.active').count()) === 0);
      await shot('05-settings-probe');
      await write.locator('.il-pipe-models .il-chip').first().click();
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
    const cliGroup = write.getByRole('radiogroup', { name: /Which CLI/i });
    await cliGroup.getByRole('radio').first().waitFor({ timeout: 5_000 });
    const cliNames = (await cliGroup.getByRole('radio').allInnerTexts()).map((s) => s.trim());
    r.rec('writing on this computer offers the four coding CLIs', cliNames.join('|') === 'Claude Code|Codex|Grok|Kimi', cliNames.join(' | '));
    r.rec('the model field starts as the CLI default "-"', (await write.locator('label input[type=text]').last().inputValue()) === '-');
    await cliGroup.getByRole('radio', { name: /^Codex$/ }).click();
    await write.getByRole('button', { name: /Check this step/i }).click();
    await writeResult.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    await writeResult.waitFor({ state: 'visible', timeout: 30_000 });
    const cliClass = (await writeResult.getAttribute('class')) ?? '';
    const cliText = await writeResult.innerText().catch(() => '');
    if (resolveCli(process.env['CODEX_BIN']?.trim() || 'codex', process.env)) {
      r.rec('Codex on PATH checks green with the file it resolved to', cliClass.includes('il-pipe-result--ok') && /codex/i.test(cliText), cliText);
    } else {
      r.rec('Codex missing from PATH is a red "Not yet."', cliClass.includes('il-pipe-result--bad') && /not on PATH/.test(cliText), cliText);
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
    await page.getByRole('link', { name: /Saludos/i }).first().click();
    await seen('Takeaway');
    r.rec('lesson article renders', (await page.locator('.il-lesson-article').count()) > 0);
    r.rec('glossary cards render', (await page.locator('.il-vocab-card').count()) >= 3);
    await shot('07-es-lesson');

    const quiz = page.locator('app-quiz');
    await quiz.waitFor({ timeout: 10_000 });
    const items = quiz.locator('ol > li');
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const li = items.nth(i);
      const kind = (await li.locator('span.uppercase').first().innerText()).trim().toLowerCase();
      if (kind === 'mc') {
        await li.locator('input[type=radio]').first().check();
      } else if (kind === 'fill') {
        await li.locator('input[type=text]').fill('x');
      } else {
        await li.locator('textarea').fill('hola');
        const reveal = li.getByRole('button', { name: /Show model answer/i });
        if (await reveal.count()) {
          await reveal.click();
          const close = li.getByRole('button', { name: /Close enough/i });
          try {
            await close.waitFor({ state: 'visible', timeout: 5_000 });
            await close.click();
          } catch {
            // Check-enabled rec below records the miss instead of aborting the walk.
          }
        }
      }
    }
    const check = quiz.getByRole('button', { name: 'Check', exact: true });
    await check.waitFor({ state: 'visible', timeout: 10_000 });
    r.rec('quiz Check enables once every translate item is graded', await check.isEnabled(), `questions=${n}`);
    if (await check.isEnabled()) {
      await check.click();
      await page.waitForTimeout(400);
      const score = (await quiz.innerText()).match(/\d+\s*\/\s*\d+/)?.[0];
      r.rec('quiz submit shows a score', !!score, score);
    }
    await shot('08-es-quiz');

    const topic = page.locator('.il-topic-chip').first();
    if (await topic.count()) {
      await topic.click();
      await page.waitForTimeout(500);
      r.rec('topic chip filters the lesson list', (await page.locator('.il-filter-bar, .il-filter-value').count()) > 0, page.url());
    }

    await goto('/es-en/vocab');
    await seen('hola');
    await page.getByPlaceholder(/Search/i).first().fill('gusto');
    await page.waitForTimeout(300);
    r.rec('glossary search narrows the list', /gusto/i.test(await body()) && !/^\s*$/.test(await body()));
    await shot('09-es-glossary');

    await goto('/es-en/flashcards');
    await seen(/Cards|Flashcards/);
    const typeInput = page.getByPlaceholder(/your answer/i);
    if (await typeInput.count()) {
      await typeInput.fill('zzzz-wrong');
      // The button reads "Check" plus an "Enter" key hint, so match the start of its name.
      await page.getByRole('button', { name: /^Check\b/ }).first().click();
      await page.waitForTimeout(400);
      r.rec('flashcards grade a wrong typed answer', /Wrong|Correct:/.test(await body()));
    } else {
      r.skip('flashcards grade a wrong typed answer', 'no typing input on the first card');
    }
    await shot('10-es-cards');

    await goto('/es-en/search');
    await page.locator('input[type=search]').first().fill('hola');
    await page.waitForTimeout(800);
    r.rec('search finds hola', /hola/i.test(await body()) && !/Nothing for/i.test(await body()));
    await shot('11-es-search');

    await goto('/es-en/cheatsheet');
    await seen('Sheet');
    r.rec('cheat sheet page loads', true);
    await goto('/es-en/compose');
    await seen('Add a conspect');
    r.rec('Add warns that hearing is skipped', (await page.getByText(/Hearing is not set up|paste a transcript/i).count()) > 0);
    await shot('12-es-compose');

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
    await goto(`/${TEST}/compose`);
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
    const burger = page.locator('.il-hamburger');
    r.rec('mobile hamburger visible', await burger.isVisible());
    await burger.click();
    await page.waitForTimeout(300);
    r.rec('mobile menu opens', await page.locator('.il-mobile-menu').isVisible());
    await shot('16-mobile-menu');
    await page.locator('.il-mobile-menu').getByRole('link', { name: /Glossary/i }).click();
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
