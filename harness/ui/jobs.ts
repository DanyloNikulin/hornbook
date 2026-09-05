import type { JobView } from '../../src/lib/api-types.ts';
import type { UiScenario } from './context.ts';

export async function jobsScenario({ r, page, pageErrors, goto, shot }: UiScenario): Promise<void> {
  const job: JobView = { id: 'cleanup-fixture', section: 'es-en', kind: 'process', status: 'done', label: 'Saved lesson', createdAt: '2026-01-01T12:00:00Z', log: '', result: { slug: 'saved' }, cleanup: { status: 'failed', error: 'Synthetic cleanup failure' } };
  let attempts = 0;
  await page.route('**/api/jobs', (route) => route.fulfill({ json: [job] }));
  await page.route('**/api/jobs/cleanup-fixture/cleanup', async (route) => {
    if (route.request().method() !== 'POST') throw new Error('Cleanup retry must use POST');
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 409, json: { error: 'Cleanup still blocked' } });
    else { delete job.cleanup; await route.fulfill({ json: job }); }
  });
  await goto('/jobs');
  const row = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Saved lesson' }) });
  await row.getByText('Cleanup needs attention.', { exact: false }).waitFor();
  r.rec('successful job retains completion alongside cleanup warning', (await row.innerText()).includes('100%'));
  const retry = row.getByRole('button', { name: 'Retry cleanup' });
  await retry.click();
  await row.getByText('Cleanup still blocked', { exact: false }).waitFor();
  r.rec('failed retry keeps the job and retry action visible', await retry.isVisible());
  const expected = 'Failed to load resource: the server responded with a status of 409 (Conflict)';
  r.rec('the injected cleanup retry failure was observed', pageErrors.filter((error) => error === expected).length === 1);
  const index = pageErrors.indexOf(expected);
  if (index >= 0) pageErrors.splice(index, 1);
  await retry.click();
  await retry.waitFor({ state: 'detached' });
  r.rec('successful retry clears warning without changing job success', attempts === 2 && (await row.innerText()).includes('100%'));
  job.cleanup = { status: 'failed', error: 'Synthetic cleanup failure' };
  await page.evaluate(() => localStorage.setItem('hornbook-locale', 'it'));
  await page.reload();
  await page.getByRole('button', { name: 'Riprova la pulizia' }).waitFor();
  r.rec('cleanup recovery has Italian controls', await page.getByText('La pulizia richiede attenzione.', { exact: false }).isVisible());
  await shot('jobs-cleanup');
}
