#!/usr/bin/env node
// Smoke the exact payload before Store signing. Installed-package checks remain separate.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Report, outDir, repoRoot } from './lib.ts';
import type { JobView, SetupView } from '../src/lib/api-types.ts';
import type { HornbookDesktopBridge } from '../src/lib/desktop.ts';

async function main(): Promise<void> {
  const report = new Report('msix');
  const infoPath = process.argv[2];
  if (!infoPath) throw new Error('Pass the build-info.json produced by package:msix.');
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { app: string; artifact: string };
  const installedExe = process.env['HORNBOOK_MSIX_INSTALLED_EXE'];
  if (!existsSync(info.artifact)) throw new Error('MSIX artifact missing.');
  mkdirSync(outDir, { recursive: true });
  const profile = mkdtempSync(join(outDir, 'msix-profile-'));
  let feedRequests = 0;
  const feed = createServer((_req, res) => { feedRequests++; res.writeHead(500).end(); });
  await new Promise<void>((done) => feed.listen(0, '127.0.0.1', done));
  const address = feed.address();
  if (!address || typeof address === 'string') throw new Error('Test feed unavailable.');
  const env: NodeJS.ProcessEnv = { ...process.env, HORNBOOK_ELECTRON_PROFILE: profile,
    HORNBOOK_TOOLS: join(profile, 'tools'),
    HORNBOOK_RELEASES_URL: `http://127.0.0.1:${address.port}/releases`, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  delete env['ELECTRON_RUN_AS_NODE'];
  const launch = () => electron.launch({ executablePath: installedExe || join(info.app, 'Hornbook.exe'),
    args: ['--journal', join(profile, 'journal')],
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    timeout: 30_000 }).catch((error: unknown) => {
      feed.close();
      report.rec('Store payload launches', false, (error as Error).message);
      report.finish();
      throw error;
    });
  let application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByText('Language pairs', { exact: true }).waitFor({ timeout: 30_000 });
    if (installedExe) {
      report.rec('Windows assigned a package identity to the installed process',
        await application.evaluate(() => process.windowsStore === true));
    }
    const state = await page.evaluate(() => (window as Window & { hornbookDesktop?: HornbookDesktopBridge }).hornbookDesktop!.state());
    report.rec('Store payload starts with an isolated journal', resolve(state.journal) === resolve(profile, 'journal'));
    report.rec('GitHub installer updates are disabled', state.update.managedBy === 'microsoft-store' && !state.update.installable);
    await page.evaluate(async () => {
      await (window as Window & { hornbookDesktop?: HornbookDesktopBridge }).hornbookDesktop!.checkForUpdates(false);
      await fetch('/api/update?force=1');
    });
    report.rec('forced API checks do not contact GitHub', feedRequests === 0);
    const origin = new URL(page.url()).origin;
    report.rec('local API still requires the desktop token', (await fetch(`${origin}/api/mode`)).status === 401);
    await page.goto(`${origin}/settings`);
    await page.getByText('Updates are managed by Microsoft Store.', { exact: true }).waitFor();
    report.rec('settings explain Store updates', await page.getByRole('button', { name: 'Open Microsoft Store', exact: true }).isVisible());
    report.rec('ordinary automatic update switch is hidden', await page.getByText('Check automatically', { exact: true }).count() === 0);
    const after = await page.evaluate(() => (window as Window & { hornbookDesktop?: HornbookDesktopBridge }).hornbookDesktop!.setPreferences({ startWithSystem: true, automaticUpdates: false }));
    report.rec('Store payload refuses legacy startup and updater preference changes', !after.preferences.startWithSystem && after.preferences.automaticUpdates);
    report.rec('Store payload refuses EXE update installation', !(await page.evaluate(() => (window as Window & { hornbookDesktop?: HornbookDesktopBridge }).hornbookDesktop!.restartToUpdate())));
    const setup = await page.evaluate(async () => (await fetch('/api/setup')).json()) as SetupView;
    report.rec('managed tools live outside the application package', resolve(setup.toolsDir) === resolve(profile, 'tools'), setup.toolsDir);
    const child = await application.evaluate(async () => {
      const { execFile } = process.getBuiltinModule('child_process');
      return new Promise<string>((done, fail) => execFile(process.execPath, ['-e', 'process.stdout.write("child-ok")'],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
        (error, stdout) => error ? fail(error) : done(stdout)));
    });
    report.rec('packaged Electron can run pipeline subprocesses', child === 'child-ok');
    const demo = readFileSync(join(repoRoot, 'journal', 'es-en', '2026-01-01-greetings.json')).toString('base64');
    const job = await page.evaluate(async (base64) => {
      const response = await fetch('/api/sections/es-en/uploads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'process', filename: 'msix-test.json', base64,
          date: '2099-01-01', title: 'MSIX lesson test', from: 'json' }),
      });
      if (!response.ok) throw new Error(`Lesson upload failed: ${response.status}`);
      const started = await response.json() as { id: string };
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const current = await (await fetch(`/api/jobs/${encodeURIComponent(started.id)}`)).json() as JobView;
        if (current.status === 'done' || current.status === 'failed') return current;
        await new Promise((done) => setTimeout(done, 250));
      }
      throw new Error('Lesson job timed out.');
    }, demo);
    report.rec('compiled lesson job writes the isolated journal', job.status === 'done' && job.result?.slug === 'msix-lesson-test', `${job.status}: ${job.error ?? ''}`);
    await page.locator('.il-update-settings').screenshot({ path: join(profile, 'store-settings.png') });
    await page.evaluate(() => (window as Window & { hornbookDesktop?: HornbookDesktopBridge }).hornbookDesktop!.setPreferences({ theme: 'night' }));
    await application.close();
    application = await launch();
    const reopened = await application.firstWindow();
    await reopened.getByText('Language pairs', { exact: true }).waitFor();
    const restored = await reopened.evaluate(async () => ({
      state: await (window as Window & { hornbookDesktop?: HornbookDesktopBridge }).hornbookDesktop!.state(),
      lesson: (await fetch('/api/sections/es-en/lessons/msix-lesson-test')).status,
    }));
    report.rec('journal and preferences survive an app restart', restored.state.preferences.theme === 'night' && restored.lesson === 200);
    report.rec('no background GitHub update traffic', feedRequests === 0);
    report.skip(installedExe ? 'real AI models and Store certification' : 'installed MSIX, real AI tools and Store certification',
      installedExe ? 'No real models downloaded; certification requires Partner Center.' : 'Payload smoke only. Requires a trusted test certificate or Store-signed package; no real models downloaded.');
  } catch (error) {
    report.rec('Store payload smoke completes', false, (error as Error).message);
    throw error;
  } finally {
    await application.close();
    await new Promise<void>((done) => feed.close(() => done()));
    report.finish({ artifact: info.artifact, profile });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
