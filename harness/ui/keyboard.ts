import type { UiScenario } from './context.ts';

export async function keyboardScenario({ page, goto, r }: UiScenario): Promise<void> {
  await goto('/es-en/flashcards');
  const input = page.locator('.il-study-input');
  await input.waitFor();
  const pairs = page.getByRole('button', { name: 'Pairs', exact: true });
  await pairs.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.il-cards-filter-group--mode .il-chip:last-child')?.classList.contains('active'), undefined, { timeout: 2000 });
  r.rec('Enter activates the focused mode button', await pairs.evaluate((el) => el.classList.contains('active')));
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await input.waitFor();
  const deck = page.locator('.il-cards-deck-select select');
  await deck.focus();
  const prevented = await deck.evaluate((el) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  r.rec('Enter on the deck selector is left to the native control', !prevented && await input.isVisible());
  await page.keyboard.press('Escape');
  await input.fill('test answer');
  await input.press('Enter');
  const next = page.locator('.il-study-actions .il-study-primary');
  await next.waitFor();
  r.rec('Answer Enter submits and focuses Next', await next.evaluate((el) => el === document.activeElement));
  await page.keyboard.press('Enter');
  await input.waitFor();
  r.rec('Next Enter advances and focuses the next answer', await input.evaluate((el) => el === document.activeElement));
}
