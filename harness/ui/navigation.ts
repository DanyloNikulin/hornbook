/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { UiScenario } from './context.ts';
const TEST = 'ja-en';

export async function navigationScenario({
  r,
  page,
  shot,
  goto,
  seen,
  body,
}: UiScenario): Promise<void> {
  r.section('Italian pair + routing');
  await goto('/it-en');
  await seen('Saluti');
  await page
    .getByRole('link', { name: /Saluti/i })
    .first()
    .click();
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
    r.rec(
      'in-pair 404 links to that pair’s search',
      /\/es-en\/search(\?|$)/.test(page.url()),
      page.url(),
    );
  }
  await goto('/zz-zz');
  await page.waitForTimeout(600);
  r.rec(
    'unknown pair shows not-found at its own URL',
    /\/zz-zz$/.test(page.url()) && /Page not found/.test(await body()),
    page.url(),
  );

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
  await cols
    .nth(0)
    .locator('.il-lang-option')
    .filter({ has: page.locator('.il-lang-name', { hasText: /^Japanese$/ }) })
    .click();
  await cols
    .nth(1)
    .locator('.il-lang-option')
    .filter({ has: page.locator('.il-lang-name', { hasText: /^English$/ }) })
    .click();
  await page.getByPlaceholder(/e\.g\. Italian/i).fill('Harness UI pair');
  await page.getByRole('button', { name: /Create pair/i }).click();
  await page.waitForURL(/\/ja-en/, { timeout: 10_000 });
  r.rec(`UI creates ${TEST}`, page.url().includes(`/${TEST}`), page.url());
  const emptyPairState = page.locator('.il-empty-state--lessons');
  await emptyPairState.waitFor({ state: 'visible', timeout: 10_000 });
  const addFirst = emptyPairState.getByRole('link', { name: /Add the first conspect/i });
  r.rec(
    'empty pair points straight at its first lesson',
    /No lessons yet/.test(await emptyPairState.innerText()) &&
      (await addFirst.getAttribute('href')) === `/${TEST}/compose`,
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
  await page
    .getByRole('heading', { name: 'All lessons' })
    .waitFor({ state: 'visible', timeout: 10_000 });
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
    pairText.length === 3 &&
      pairText.every((text) => /[A-Z]{2}-[A-Z]{2}/.test(text)) &&
      (await mobileMenu.locator('.il-mobile-pair[aria-current=true]').count()) === 1 &&
      /current/i.test(pairText.join(' ')),
    pairText.join(' | '),
  );
  await shot('16-mobile-menu');
  await mobileMenu.getByRole('link', { name: /Glossary/i }).click();
  await page.waitForTimeout(600);
  r.rec('mobile nav reaches the glossary', page.url().includes('/vocab'), page.url());
}
