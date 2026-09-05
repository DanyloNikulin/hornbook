/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { UiScenario } from './context.ts';
import { join } from 'node:path';
import { resolveCli } from '../../scripts/lib/cli-path.ts';
import { reachable } from '../lib.ts';

export async function settingsScenario({
  r,
  page,
  context,
  base,
  screens: SCREENS,
  ollamaUp,
  shot,
  goto,
  seen,
  body,
}: UiScenario): Promise<void> {
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
      (await newJournalState
        .getByRole('link', { name: /Create the first pair/i })
        .getAttribute('href')) === '/setup',
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
  const reducedDuration = await page
    .locator('.il-theme-btn')
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  r.rec(
    'reduced-motion preference removes decorative transitions',
    Number.parseFloat(reducedDuration) <= 0.001,
    reducedDuration,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const flagFont = await page.evaluate(async () => {
    await document.fonts.load('28px "Twemoji Country Flags"', '\u{1F1EA}\u{1F1F8}');
    const face = [...document.fonts].find(
      (f) => f.family.replace(/"/g, '') === 'Twemoji Country Flags',
    );
    return {
      status: face?.status ?? 'missing',
      check: document.fonts.check('28px "Twemoji Country Flags"', '\u{1F1EA}\u{1F1F8}'),
    };
  });
  r.rec(
    'bundled flag font loads (Windows shows flags, not "ES")',
    flagFont.status === 'loaded' && flagFont.check,
    JSON.stringify(flagFont),
  );
  const flagFamily = await page
    .locator('.il-section-flags')
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily);
  r.rec(
    'flag elements ask for the flag font first',
    /Twemoji Country Flags/.test(flagFamily),
    flagFamily,
  );
  await shot('01-home');

  await page
    .getByRole('link', { name: /New pair/i })
    .first()
    .click();
  await seen('New language pair');
  r.rec(
    'setup catalogue has the bundled languages',
    (await page.locator('.il-lang-option').count()) > 40,
  );
  r.rec(
    'setup offers pair archive import',
    await page.getByRole('heading', { name: /Import a language pair/i }).isVisible(),
  );
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

  r.rec('guided setup is shown before advanced providers', await page.getByRole('heading', { name: 'From a lesson to a study note' }).isVisible() && await page.locator('.il-pipe').count() === 0);
  await page.getByText('Advanced: model providers & connections', { exact: true }).click();
  const hear = page.locator('.il-pipe').nth(0);
  const chips = hear.locator('[role=radiogroup] .il-chip');
  r.rec(
    'hearing offers three places',
    (await chips.count()) >= 3,
    (await chips.allInnerTexts()).join(' | '),
  );
  await chips.filter({ hasText: /paste the text/i }).click();
  await hear.getByRole('button', { name: /Check this step|Find models/i }).click();
  const hearResult = hear.locator('.il-pipe-result');
  await hearResult.waitFor({ state: 'visible', timeout: 20_000 });
  r.rec(
    'skip-hearing probe is green',
    (await hearResult.getAttribute('class'))?.includes('il-pipe-result--ok') === true,
    await hearResult.innerText().catch(() => ''),
  );

  // Probes answer within the server's 8 s timeout; a busy Ollama can use all of it.
  const write = page.locator('.il-pipe').nth(1);
  await write
    .locator('[role=radiogroup] .il-chip')
    .filter({ hasText: /Home network/i })
    .click();
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
    const sortedModels = [...models].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );
    r.rec(
      'Find models opens a sorted dropdown and is not painted red',
      writeClass.includes('il-pipe-result--pick') &&
        !writeClass.includes('il-pipe-result--bad') &&
        models.length > 0 &&
        /Connected\./.test(writeText) &&
        models.join('|') === sortedModels.join('|'),
      `${writeText} | ${models.join(', ')}`,
    );
    r.rec(
      'no model is chosen for the user',
      /Choose a model/i.test(await picker.locator('.il-model-picker-trigger').innerText()),
    );
    const searchModels = picker.locator('.il-model-search');
    await searchModels.fill('qwen');
    const filteredModels = (await modelOptions.allInnerTexts()).map((model) => model.trim());
    r.rec(
      'model dropdown filters while typing',
      filteredModels.length > 0 && filteredModels.every((model) => /qwen/i.test(model)),
      filteredModels.join(', '),
    );
    await shot('05-settings-probe');
    await modelOptions.first().click();
    await write.getByRole('button', { name: /Check this step/i }).click();
    await writeResult.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    await writeResult.waitFor({ state: 'visible', timeout: 30_000 });
    const after = (await writeResult.getAttribute('class')) ?? '';
    r.rec(
      'a picked model checks green',
      after.includes('il-pipe-result--ok'),
      await writeResult.innerText().catch(() => ''),
    );
  } else {
    r.rec(
      'Find models without Ollama is a red "Not yet."',
      writeClass.includes('il-pipe-result--bad') && /Not yet\./.test(writeText),
      writeText,
    );
    r.skip('Find models lists pulled models', 'no Ollama reachable');
    await shot('05-settings-probe');
  }

  // Writing on this computer: the coding CLIs. The probe only knows whether
  // the CLI is installed, so an installed one reads green with the file it
  // resolved to and a missing one is a red "Not yet.".
  await write
    .locator('[role=radiogroup] .il-chip')
    .filter({ hasText: /This computer/i })
    .first()
    .click();
  const cliGroup = write.locator('.il-cli-list');
  await cliGroup.locator('.il-cli-option').first().waitFor({ timeout: 5_000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.il-cli-list .il-cli-status').length === 4 &&
      ![...document.querySelectorAll('.il-cli-list .il-cli-status')].some((el) =>
        /Checking/.test(el.textContent ?? ''),
      ),
    undefined,
    { timeout: 20_000 },
  );
  const cliNames = (await cliGroup.locator('.il-cli-pick').allInnerTexts()).map((s) => s.trim());
  r.rec(
    'writing on this computer offers the four coding CLIs',
    cliNames.join('|') === 'Claude Code|Codex|Grok|Kimi',
    cliNames.join(' | '),
  );
  r.rec(
    'Grok and Kimi are marked experimental',
    (await cliGroup.locator('.il-cli-experimental').count()) === 2,
  );
  r.rec(
    'all four CLIs show an installed or missing status',
    (await cliGroup.locator('.il-cli-status--ok, .il-cli-status--bad').count()) === 4,
  );
  r.rec(
    'the model field explains the CLI default "-"',
    (await write.locator('input[type=text]').last().inputValue()) === '-' &&
      /does not override the model/i.test(await write.locator('.il-cli-default-note').innerText()),
  );
  const codex = cliGroup.locator('.il-cli-option').filter({ hasText: 'Codex' }).first();
  const codexBin = resolveCli(process.env['CODEX_BIN']?.trim() || 'codex', process.env);
  if (codexBin) {
    r.rec(
      'Codex status is installed before it is selected',
      (await codex.locator('.il-cli-status--ok').count()) === 1,
      await codex.innerText(),
    );
    await codex.locator('.il-cli-pick').click();
    await write.getByRole('button', { name: /Check this step/i }).click();
    await writeResult.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    await writeResult.waitFor({ state: 'visible', timeout: 30_000 });
    const cliClass = (await writeResult.getAttribute('class')) ?? '';
    const cliText = await writeResult.innerText().catch(() => '');
    r.rec(
      'Codex on PATH checks green with the file it resolved to',
      cliClass.includes('il-pipe-result--ok') && /codex/i.test(cliText),
      cliText,
    );
  } else {
    r.rec(
      'Codex missing from PATH is grey with an install line',
      (await codex.locator('.il-cli-status--bad').count()) === 1 &&
        /CODEX_BIN/.test(await codex.innerText()),
      await codex.innerText(),
    );
    r.skip('Codex on PATH checks green with the file it resolved to', 'Codex is not installed');
  }
  await shot('05b-settings-cli');

  // Local tools: the five rows and the one button. A plan (source, size,
  // checksum) is shown before any download; this walk fetches nothing.
  const toolRows = page.locator('.il-setup-row');
  await page.getByText('Tool details & other models', { exact: true }).click();
  r.rec(
    'local tools list the five rows',
    (await toolRows.count()) === 5,
    `n=${await toolRows.count()}`,
  );
  const setupAll = page
    .locator('button')
    .filter({ hasText: /Set up everything|Setting up|Prepara tutto|Preparazione|Check & use local tools/ })
    .first();
  r.rec('the one setup button is there', (await setupAll.count()) === 1);
  if (await reachable('https://huggingface.co/', 4000)) {
    const modelRow = page.locator('.il-setup-row[data-tool="whisper-model"]');
    await modelRow.getByRole('button', { name: /^(Download|Scarica)/ }).click();
    const plan = modelRow.locator('.il-setup-plan');
    await plan
      .filter({ hasText: /SHA-256/ })
      .first()
      .waitFor({ timeout: 20000 })
      .catch(() => undefined);
    const planText = (
      await plan
        .first()
        .innerText()
        .catch(() => '')
    ).replace(/\s+/g, ' ');
    r.rec(
      'a download shows source, size and checksum before it starts',
      /SHA-256/.test(planText) && /MB/.test(planText),
      planText.slice(0, 140),
    );
    await shot('05c-settings-tools-plan');
    await modelRow.getByRole('button', { name: /^(Cancel|Annulla)/ }).click();
    await plan
      .first()
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => undefined);
    r.rec('cancel puts the row back without fetching', (await plan.count()) === 0);
  } else {
    r.skip('download plan on the setup page', 'huggingface.co not reachable');
  }
}
