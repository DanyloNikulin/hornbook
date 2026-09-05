import type { UiScenario } from './context.ts';

export async function repairsScenario({ r, page, pageErrors, context, base, goto, shot }: UiScenario): Promise<void> {
  const nav = async (path: string) => { await page.locator(`.il-nav a[href="${path}"]`).first().click(); };
  const draft = async (title: string, text: string) => {
    await page.locator('#compose-tab-hand').click();
    await page.locator('input[type=date]').fill('2099-01-01');
    await page.locator('.il-compose-basics input[type=text]').fill(title);
    await page.locator('#compose-panel-hand textarea').last().fill(text);
  };
  await goto('/es-en/compose');
  await draft('Café audit', 'Original acknowledged note');
  await page.getByRole('button', { name: 'Save lesson', exact: true }).click();
  await page.waitForURL('**/es-en/lesson/cafe-audit');
  await nav('/es-en/compose');
  await draft('Cafe audit', 'Unrelated second note');
  const conflict = page.waitForResponse((response) => response.url().endsWith('/es-en/lessons') && response.status() === 409);
  await page.getByRole('button', { name: 'Save lesson', exact: true }).click();
  await conflict;
  const saved = await (await context.request.get(`${base}/api/sections/es-en/lessons/cafe-audit`)).json();
  r.rec('same-date normalized-title Add collision preserves the first note', saved.article_md === 'Original acknowledged note' && page.url().endsWith('/es-en/compose'));
  const expected = pageErrors.findIndex((error) => error.includes('409 (Conflict)'));
  if (expected >= 0) pageErrors.splice(expected, 1);

  await nav('/es-en/settings');
  let release!: () => void;
  let requested!: () => void;
  const requestSeen = new Promise<void>((resolve) => requested = resolve);
  const held = new Promise<void>((resolve) => release = resolve);
  await page.route('**/api/sections/es-en', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    const response = await route.fetch();
    requested();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await requestSeen;
  await page.locator('.il-section-switch').selectOption('it-en');
  await page.waitForURL('**/it-en/settings');
  await nav('/it-en/compose');
  release();
  await page.unroute('**/api/sections/es-en');
  await draft('Italian ownership audit', 'Belongs to Italian');
  const write = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/lessons'));
  await page.getByRole('button', { name: 'Save lesson', exact: true }).click();
  const written = await write;
  r.rec('a late Spanish settings response cannot redirect Italian Add', written.url().endsWith('/it-en/lessons') && written.ok());
  const italian = await context.request.get(`${base}/api/sections/it-en/lessons/italian-ownership-audit`);
  const spanish = await context.request.get(`${base}/api/sections/es-en/lessons/italian-ownership-audit`);
  r.rec('the note is persisted only in the intended section', italian.ok() && spanish.status() === 404);

  await nav('/it-en/compose');
  await page.locator('#compose-tab-recording').click();
  await page.locator('#compose-panel-recording input[type=file]').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: Buffer.from('fixture') });
  r.rec('recording Start is disabled while hearing is skipped', await page.getByRole('button', { name: 'Start', exact: true }).isDisabled());
  await nav('/it-en/settings');
  await page.locator('.il-settings-tabs a[href="/it-en/application"]').click();
  await page.getByText('Advanced: model providers & connections', { exact: true }).click();
  const hearing = page.locator('.il-pipe').first();
  await hearing.getByRole('radio', { name: 'This computer', exact: true }).click();
  await hearing.locator('input[aria-label]').last().fill('synthetic-small.bin');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Saved.', { exact: true }).waitFor();
  await nav('/it-en/compose');
  await page.locator('#compose-panel-recording input[type=file]').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: Buffer.from('fixture') });
  r.rec('saved hearing defaults enable Add immediately without reload', await page.getByRole('button', { name: 'Start', exact: true }).isEnabled());
  await nav('/it-en/settings');
  await page.locator('.il-settings-tabs a[href="/it-en/application"]').click();
  await shot('repair-guided-setup');
  await page.getByText('Advanced: model providers & connections', { exact: true }).click();
  await page.locator('.il-pipe').first().getByRole('radio', { name: /paste the text/i }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Saved.', { exact: true }).waitFor();
  await nav('/it-en/compose');
  await page.locator('#compose-panel-recording input[type=file]').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: Buffer.from('fixture') });
  r.rec('disabling hearing takes effect without reload too', await page.getByRole('button', { name: 'Start', exact: true }).isDisabled());
}
