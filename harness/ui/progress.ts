import type { UiScenario } from './context.ts';

export async function progressScenario({
  r,
  page,
  pageErrors,
  context,
  base,
  goto,
}: UiScenario): Promise<void> {
  const progressPath = '**/api/sections/es-en/progress';
  const saved = await (await context.request.get(`${base}/api/sections/es-en/progress`)).json();
  await page.route(progressPath, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Progress unavailable (fixture)' }),
        })
      : route.continue(),
  );
  await goto('/es-en/flashcards');
  await page.getByText('Progress unavailable (fixture)', { exact: false }).waitFor();
  await page.locator('main [inert]').waitFor({ state: 'attached' });
  r.rec(
    'failed progress load blocks study interactions',
    (await page.locator('main [inert]').count()) === 1,
  );
  await page.unroute(progressPath);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('main [inert]'));
  r.rec('retry unlocks study after a successful progress load', true);

  let failSave = true;
  await page.route(progressPath, (route) =>
    route.request().method() === 'PUT' && failSave
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Save unavailable (fixture)' }),
        })
      : route.continue(),
  );
  // A pending draft exercises restart restoration through the same production save queue.
  await page.evaluate(
    ({ saved }) => {
      localStorage.setItem(
        `hornbook-progress:${saved.journalKey}:es-en:fixture`,
        JSON.stringify({
          revision: saved.revision,
          snapshot: {
            sm2: saved.sm2,
            daily: saved.daily,
            quiz: saved.quiz,
            activity: { ...saved.activity, '2026-09-04': 7 },
          },
        }),
      );
    },
    { saved },
  );
  await page.reload();
  await page.getByText('Save unavailable (fixture)', { exact: false }).waitFor();
  r.rec(
    'failed restored save exposes retained progress and a download',
    await page.getByRole('button', { name: 'Download unsaved progress' }).isVisible(),
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download unsaved progress' }).click();
  r.rec(
    'unsaved progress can be exported',
    (await download).suggestedFilename() === 'es-en-unsaved-progress.json',
  );
  failSave = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page
    .getByText('Save unavailable (fixture)', { exact: false })
    .waitFor({ state: 'detached' });
  const after = await (await context.request.get(`${base}/api/sections/es-en/progress`)).json();
  r.rec('retry acknowledges the retained snapshot', after.activity['2026-09-04'] === 7);
  const stale = await context.request.put(`${base}/api/sections/es-en/progress`, {
    data: { ...saved, activity: {} },
  });
  r.rec('stale client cannot erase the acknowledged history', stale.status() === 409);
  await page.unroute(progressPath);
  const expected =
    'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
  const failures = pageErrors.filter((error) => error === expected);
  r.rec('the two injected HTTP failures were observed', failures.length === 2);
  for (let i = 0; i < 2; i++) {
    const index = pageErrors.indexOf(expected);
    if (index >= 0) pageErrors.splice(index, 1);
  }

  const brokenKey = `hornbook-progress:${saved.journalKey}:es-en:broken`;
  await page.evaluate((key) => localStorage.setItem(key, '{broken'), brokenKey);
  await page.reload();
  const useSaved = page.getByRole('button', {
    name: 'Discard unsaved changes and use saved progress',
  });
  await useSaved.waitFor();
  await page.locator('main [inert]').waitFor({ state: 'attached' });
  r.rec(
    'an unreadable backup offers recovery while study is blocked',
    (await page.locator('main [inert]').count()) === 1,
  );
  await useSaved.click();
  await page.waitForFunction(() => !document.querySelector('main [inert]'));
  r.rec(
    'choosing saved progress removes the corrupt backup',
    await page.evaluate((key) => localStorage.getItem(key) === null, brokenKey),
  );

  await page.addInitScript(`(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    const check = (key) => {
      if (key.startsWith('hornbook-progress:'))
        throw new DOMException('Storage unavailable (fixture)', 'SecurityError');
    };
    Storage.prototype.getItem = function (key) {
      check(key);
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      check(key);
      setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      check(key);
      removeItem.call(this, key);
    };
  })()`);
  await page.reload();
  await page.locator('main [inert]').waitFor({ state: 'attached' });
  await useSaved.click();
  await page.waitForFunction(() => !document.querySelector('main [inert]'));
  r.rec(
    'unavailable local storage can be bypassed explicitly',
    await page
      .getByText('Local backups are unavailable for this session.', { exact: false })
      .isVisible(),
  );
  const input = page.getByPlaceholder(/your answer/i);
  await input.fill('zzzz-wrong');
  await input.press('Enter');
  const save = page.waitForResponse(
    (response) =>
      response.url().endsWith('/es-en/progress') && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: /^Next/ }).click();
  r.rec('studying still saves to the journal with local storage unavailable', (await save).ok());
  const studied = await (await context.request.get(`${base}/api/sections/es-en/progress`)).json();
  r.rec(
    'recovered study preserves history and records the reviewed card',
    studied.activity['2026-09-04'] === 7 &&
      JSON.stringify(studied.sm2) !== JSON.stringify(after.sm2),
  );
}
