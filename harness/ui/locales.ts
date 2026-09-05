/// <reference lib="dom" />
import type { UiScenario } from './context.ts';

export async function localesScenario({ r, page, goto, shot }: UiScenario): Promise<void> {
  const choices = [
    { id: 'es', name: 'Español', title: 'Aplicación' },
    { id: 'fr', name: 'Français', title: 'Application' },
    { id: 'de', name: 'Deutsch', title: 'Anwendung' },
    { id: 'pt', name: 'Português (Portugal)', title: 'Aplicação' },
    { id: 'nl', name: 'Nederlands', title: 'Applicatie' },
    { id: 'sv', name: 'Svenska', title: 'Program' },
    { id: 'uk', name: 'Українська', title: 'Застосунок' },
  ];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await goto('/settings');
    await page.getByRole('radio', { name: /English/ }).waitFor();
    r.rec(
      `${width}px: all nine interface languages are available`,
      (await page.getByRole('radiogroup').first().getByRole('radio').count()) === 9,
    );
    for (const choice of choices) {
      const radio = page.getByRole('radio', {
        name: `${choice.name} ${choice.id.toUpperCase()}`,
        exact: true,
      });
      await radio.click();
      await page.waitForFunction((id) => document.documentElement.lang === id, choice.id);
      r.rec(
        `${width}px: ${choice.name} translates the page`,
        (await page.locator('h1').innerText()) === choice.title,
      );
      r.rec(
        `${width}px: ${choice.name} is selected`,
        (await radio.getAttribute('aria-checked')) === 'true',
      );
      const bounds = await page
        .locator('.il-locale-picks')
        .first()
        .evaluate((element) => ({
          width: element.clientWidth,
          content: element.scrollWidth,
          right: element.getBoundingClientRect().right,
          viewport: document.documentElement.clientWidth,
        }));
      r.rec(
        `${width}px: ${choice.name} picker fits`,
        bounds.content <= bounds.width + 1 && bounds.right <= bounds.viewport + 1,
        JSON.stringify(bounds),
      );
      r.rec(
        `${width}px: ${choice.name} page fits`,
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      );
      if (width < 640) {
        const menu = page.locator('.il-hamburger');
        const box = await menu.boundingBox();
        r.rec(
          `${choice.name} mobile menu stays on-screen`,
          box !== null && box.x >= 0 && box.x + box.width <= width,
        );
        await menu.click();
        await page.locator('.il-mobile-menu').waitFor({ state: 'visible' });
        r.rec(
          `${choice.name} mobile menu opens`,
          await page.locator('.il-mobile-menu').isVisible(),
        );
        await menu.click();
        await page.locator('.il-mobile-menu').waitFor({ state: 'hidden' });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: choice.title, exact: true }).waitFor();
      if (choice.id === 'uk') {
        const fontsLoaded = await page.evaluate(async () => {
          const sample = 'Ґґ Єє Іі Її';
          const fonts = ['400 16px Manrope', '600 24px "Cormorant Garamond"'];
          const faces = await Promise.all(fonts.map((font) => document.fonts.load(font, sample)));
          return (
            faces.every(
              (loaded) => loaded.length > 0 && loaded.every((face) => face.status === 'loaded'),
            ) && fonts.every((font) => document.fonts.check(font, sample))
          );
        });
        r.rec(`${width}px: Ukrainian font subsets load`, fontsLoaded);
      }
      r.rec(
        `${width}px: ${choice.name} survives reload`,
        await page.evaluate(
          (id) =>
            document.documentElement.lang === id && localStorage.getItem('hornbook-locale') === id,
          choice.id,
        ),
      );
      if (choice.id === 'de' || choice.id === 'pt' || choice.id === 'uk')
        await shot(`locale-${choice.id}-${width}`);
    }
  }
  await goto('/es-en');
  await page.locator('h1').waitFor();
  r.rec(
    'opening a learning pair preserves the interface language',
    await page.evaluate(() => document.documentElement.lang === 'uk'),
  );
  await goto('/settings');
  await page.getByRole('radio', { name: 'English EN', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  r.rec('can return to English', (await page.locator('h1').innerText()) === 'Application');
}
