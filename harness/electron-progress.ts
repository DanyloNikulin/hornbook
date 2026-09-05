/// <reference lib="dom" />
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import type { HornbookDesktopBridge } from '../src/lib/desktop.ts';
import { Report, outDir, repoRoot, throwawayJournal } from './lib.ts';

async function main(): Promise<void> {
  const report = new Report('electron-progress');
  const journal = throwawayJournal('electron-progress', { fromDemo: true });
  const profiles = join(outDir, 'profiles');
  mkdirSync(profiles, { recursive: true });
  const profile = mkdtempSync(join(profiles, 'progress-'));
  const electronDir = join(repoRoot, 'node_modules', 'electron');
  const executablePath = join(
    electronDir,
    'dist',
    readFileSync(join(electronDir, 'path.txt'), 'utf8').trim(),
  );
  if (!existsSync(executablePath))
    throw new Error('Install the pinned Electron dependency before running this harness');
  const launch = () =>
    electron.launch({
      timeout: 30000,
      executablePath,
      args: [resolve(repoRoot), '--journal', journal],
      env: {
        ...process.env,
        HORNBOOK_ELECTRON_PROFILE: profile,
        HORNBOOK_SKIP_AUTO_UPDATER: '1',
        HORNBOOK_RELEASES_URL: 'http://127.0.0.1:1/latest',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.getByText('Language pairs', { exact: true }).waitFor();
    const origin = new URL(page.url()).origin;
    await page.route('**/api/sections/es-en/progress', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Offline draft fixture' }),
          })
        : route.continue(),
    );
    const error = await page.evaluate(async () => {
      const view = await (await fetch('/api/sections/es-en/progress')).json();
      return (
        window as unknown as Window & { hornbookDesktop: HornbookDesktopBridge }
      ).hornbookDesktop.progressDraft('es-en', {
        revision: view.revision,
        snapshot: {
          sm2: view.sm2,
          daily: view.daily,
          quiz: view.quiz,
          activity: { '2026-09-04': 7 },
        },
      }).error;
    });
    report.rec('preload stores the pending snapshot synchronously', error === undefined, error);
    await page.goto(`${origin}/es-en/flashcards`);
    await page.getByText('Offline draft fixture', { exact: false }).waitFor();
    report.rec(
      'failed desktop save retains an on-disk draft',
      readdirSync(join(profile, 'progress-drafts')).length === 1,
    );
    await app.close();
    app = undefined;
    app = await launch();
    const restarted = await app.firstWindow();
    await restarted.getByText('Language pairs', { exact: true }).waitFor();
    const nextOrigin = new URL(restarted.url()).origin;
    report.rec('restart has a new server origin', origin !== nextOrigin);
    await restarted.goto(`${nextOrigin}/es-en/flashcards`);
    await restarted.waitForFunction(async () => {
      const view = await (await fetch('/api/sections/es-en/progress')).json();
      return view.activity['2026-09-04'] === 7;
    });
    report.rec('restart saves the pending progress from the previous origin', true);
    await restarted.waitForFunction(
      () =>
        (
          window as unknown as Window & { hornbookDesktop: HornbookDesktopBridge }
        ).hornbookDesktop.progressDraft('es-en').value === null,
    );
    report.rec(
      'acknowledgement removes the desktop draft',
      readdirSync(join(profile, 'progress-drafts')).length === 0,
    );
  } catch (error) {
    console.error(error);
    report.rec('desktop progress restart', false, String(error));
  } finally {
    await app?.close().catch(() => undefined);
  }
  report.finish({ journal, profile });
}
void main();
