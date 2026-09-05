import type { UiScenario } from './context.ts';

export async function appearanceScenario({ page, goto, r, shot }: UiScenario): Promise<void> {
  const routes = [
    '/es-en', '/es-en/lesson/greetings', '/es-en/flashcards', '/es-en/vocab',
    '/es-en/cheatsheet', '/es-en/compose', '/es-en/settings', '/es-en/application',
  ];
  for (const theme of ['day', 'night']) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const route of routes) {
        await goto(route);
        await page.evaluate((value) => {
          localStorage.setItem('hornbook-theme', value);
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        await page.locator('main h1').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const state = await page.evaluate(() => ({
          fits: document.documentElement.scrollWidth <= window.innerWidth,
          ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
        }));
        r.rec(`${route} fits ${width}px in ${theme} theme`, state.fits && !!state.ink);
        if (route.endsWith('/flashcards')) await shot(`20.5-cards-${theme}-${width}`);
      }
    }
  }
}
