#!/usr/bin/env node
// Packaged Electron smoke: real executable, isolated journal/profile, and a
// fake one-response GitHub release feed. No models, keys, or user data.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import type { JobView } from '../src/lib/api-types.ts';
import { Report, outDir, repoRoot, throwawayJournal } from './lib.ts';
import { unpackedFolder } from './package-output.ts';

function executable(): string {
  const explicit = process.env['HORNBOOK_ELECTRON_EXE']?.trim();
  if (explicit) return explicit;
  const release = join(repoRoot, 'release');
  const folders = existsSync(release) ? readdirSync(release) : [];
  if (process.platform === 'win32') {
    const folder = unpackedFolder(process.platform, process.arch, folders);
    return join(release, folder, 'Hornbook.exe');
  }
  if (process.platform === 'darwin') {
    const folder = unpackedFolder(process.platform, process.arch, folders);
    return join(release, folder, 'Hornbook.app', 'Contents', 'MacOS', 'Hornbook');
  }
  const folder = unpackedFolder(process.platform, process.arch, folders);
  return join(release, folder, 'hornbook');
}

async function main(): Promise<void> {
  const report = new Report('electron');
  const exe = executable();
  report.rec('packaged executable exists', existsSync(exe), exe);
  if (!existsSync(exe)) {
    report.finish();
    return;
  }

  let releaseGets = 0;
  const releases = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/latest') {
      res.writeHead(404).end();
      return;
    }
    releaseGets++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: 'v9.9.9',
      name: 'Hornbook 9.9.9',
      body: 'A fake release used only by the packaged-app harness.',
      html_url: 'https://github.com/DanyloNikulin/hornbook/releases/tag/v9.9.9',
      published_at: '2026-09-04T12:00:00Z',
    }));
  });
  await new Promise<void>((resolve) => releases.listen(0, '127.0.0.1', resolve));
  const address = releases.address();
  if (!address || typeof address === 'string') throw new Error('fake release feed did not listen');

  const journal = throwawayJournal('electron', { fromDemo: true });
  const profile = join(outDir, 'electron-profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const electronApp = await electron.launch({
    executablePath: exe,
    args: ['--journal', journal],
    env: {
      ...process.env,
      HORNBOOK_RELEASES_URL: `http://127.0.0.1:${address.port}/latest`,
      HORNBOOK_SKIP_AUTO_UPDATER: '1',
      HORNBOOK_ELECTRON_PROFILE: profile,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
    timeout: 30_000,
  });

  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    await page.getByText('Language pairs', { exact: true }).waitFor({ timeout: 20_000 });
    const desktop = await page.evaluate(() =>
      (window as Window & { hornbookDesktop?: { state(): Promise<{ journal: string; platform: string }> } }).hornbookDesktop?.state(),
    );
    report.rec('isolated preload exposes the desktop state', !!desktop && desktop.journal.length > 0 && desktop.platform.length > 0);

    const mode = await page.evaluate(async () => (await fetch('/api/mode')).json() as Promise<{ shell: string; version: string }>);
    report.rec('packaged window uses the Electron server mode', mode.shell === 'electron' && !!mode.version, JSON.stringify(mode));

    const origin = new URL(page.url()).origin;
    const outside = await fetch(`${origin}/api/mode`);
    report.rec('loopback server rejects a client without the launch token', outside.status === 401, outside.status);

    await page.waitForTimeout(3500);
    const update = await page.evaluate(() =>
      (window as Window & { hornbookDesktop?: { state(): Promise<{ update: { phase: string; release?: { version: string } } }> } }).hornbookDesktop?.state(),
    );
    report.rec('desktop main process sees the fake release', update?.update.phase === 'available' && update.update.release?.version === '9.9.9', JSON.stringify(update?.update));
    await page.locator('.il-update-toast').waitFor({ timeout: 15_000 });
    report.rec('fake release feed produces a compact update toast', /9\.9/.test(await page.locator('.il-update-toast').innerText()));
    const chrome = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        // macOS has an application menu; the window-menu API only supports Windows/Linux.
        menu: process.platform === 'darwin' ? null : window.isMenuBarVisible(),
        minimizable: window.isMinimizable(),
        maximizable: window.isMaximizable(),
        resizable: window.isResizable(),
      };
    });
    report.rec('desktop uses a draggable title area with native window controls and no window menu strip', !chrome.menu && chrome.minimizable && chrome.maximizable && chrome.resizable && await page.locator('.il-titlebar').isVisible(), JSON.stringify(chrome));
    await page.getByRole('button', { name: 'Dismiss', exact: false }).click();
    await page.locator('.il-update-toast').waitFor({ state: 'detached' });
    report.rec('update toast dismisses without losing settings access', await page.locator('.il-nav-links a[href="/settings"]').isVisible());
    report.rec('automatic release check makes one feed request', releaseGets === 1, releaseGets);

    const demo = JSON.parse(readFileSync(join(repoRoot, 'journal', 'es-en', '2026-01-01-greetings.json'), 'utf8')) as Record<string, unknown>;
    const job = await page.evaluate(async (base64) => {
      const created = await fetch('/api/sections/es-en/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'process',
          filename: 'packaged-copy.json',
          base64,
          date: '2099-01-01',
          title: 'Electron packaged job',
          from: 'json',
        }),
      });
      const started = await created.json() as { id: string };
      const deadline = Date.now() + 60_000;
      let current: JobView | undefined;
      while (Date.now() < deadline) {
        current = await (await fetch(`/api/jobs/${encodeURIComponent(started.id)}`)).json() as JobView;
        if (current.status === 'done' || current.status === 'failed') return current;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return current;
    }, Buffer.from(JSON.stringify(demo)).toString('base64'));
    report.rec(
      'packaged server runs compiled background jobs without tsx',
      job?.status === 'done' && job.result?.slug === 'electron-packaged-job',
      job ? `${job.status} ${job.error ?? ''} ${job.log.slice(-240)}` : 'no job',
    );

    await page.goto(`${origin}/settings`);
    await page.getByRole('heading', { name: 'This computer' }).waitFor();
    report.rec('Application settings expose native journal controls', await page.getByRole('button', { name: 'Open folder' }).isVisible() && await page.getByRole('button', { name: 'Change…' }).isVisible());
    report.rec(
      'packaged Application settings show the installed version',
      (await page.locator('.il-installed-version').innerText()).includes(`Hornbook ${mode.version}`),
      mode.version,
    );

    await page.goto(`${origin}/jobs`);
    await page.getByRole('heading', { name: 'Jobs' }).waitFor();
    const ledgerJob = page.getByRole('heading', { name: 'packaged-copy.json' });
    await ledgerJob.waitFor();
    report.rec('tray destination has a jobs ledger', await ledgerJob.isVisible());

    const screenDir = join(outDir, 'screens');
    mkdirSync(screenDir, { recursive: true });
    await page.screenshot({ path: join(screenDir, `electron-${process.platform}.png`), fullPage: true });

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await page.waitForTimeout(150);
    const hidden = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return !!window && !window.isVisible() && !window.isDestroyed();
    });
    report.rec('closing the window keeps Hornbook alive in the tray', hidden);
  } catch (error) {
    report.rec('packaged Electron walk', false, String(error));
  } finally {
    await electronApp.close().catch(() => undefined);
    await new Promise<void>((resolve) => releases.close(() => resolve()));
  }
  report.finish({ executable: exe, releaseGets });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
