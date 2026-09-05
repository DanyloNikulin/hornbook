// Helpers for the `hornbook` command: first-run journal seeding and opening
// the UI in a browser tab or in a chromeless app window. Pure where
// possible so they can be tested without launching anything.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { commitFiles, recoverJournal, type CommitObserver, type FileChange } from '../scripts/lib/file-commit.ts';
import { normalizeJournalConfig } from '../src/lib/journal-config.ts';

/** Files inside a journal that belong to one machine or one run, never to a copy. */
const SKIP_IN_SEED = new Set(['_derived', '_progress.json', '_uploads', 'secrets.json', '_transaction', '_write.lock', '_write.reclaim']);

/**
 * Copy the demo journal into `dst` when `dst` has no journal yet. Returns
 * true when something was seeded. Per-machine files are left out.
 */
export function seedJournal(src: string | readonly FileChange[], dst: string, observe?: CommitObserver): boolean {
  recoverJournal(dst);
  if (existsSync(join(dst, 'journal.config.json'))) {
    const config = normalizeJournalConfig(JSON.parse(readFileSync(join(dst, 'journal.config.json'), 'utf8')));
    if (config.sections.length && config.sections.every((section) => !existsSync(join(dst, section.id)))) {
      console.warn('Journal configuration exists but all section folders are missing. This may be an incomplete older first run or an intentionally empty journal. Existing files were preserved. To recover your lessons, restore a backup. To start again with samples, choose a NEW empty journal folder (hornbook --journal <new-empty-folder>); do not delete this folder. See docs/JOURNAL-RECOVERY.md.');
    }
    return false;
  }
  if (typeof src === 'string' && !existsSync(join(src, 'journal.config.json'))) return false;
  return commitFiles(dst, () => {
    if (existsSync(join(dst, 'journal.config.json'))) return { changes: [], result: false };
    if (readdirSync(dst).some((name) => name !== '_write.lock')) throw new Error('This folder is not empty and has no journal.config.json. Restore its configuration from a backup or choose a new empty folder; existing files have been preserved.');
    const changes: FileChange[] = [];
    const collect = (parts: string[]) => {
      if (typeof src !== 'string') return;
      for (const entry of readdirSync(join(src, ...parts), { withFileTypes: true })) {
        if (SKIP_IN_SEED.has(entry.name) || entry.name.startsWith('.') || /(?:corrupt-|recovery|_pending-)/.test(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error('Demo data contains a symbolic link');
        const child = [...parts, entry.name];
        if (entry.isDirectory()) collect(child);
        else changes.push({ path: child.join('/'), data: readFileSync(join(src, ...child)) });
      }
    };
    if (typeof src === 'string') collect([]);
    else changes.push(...src);
    const config = changes.find((change) => change.path === 'journal.config.json');
    if (typeof config?.data !== 'string' && !(config?.data instanceof Uint8Array)) throw new Error('Demo configuration is missing');
    normalizeJournalConfig(JSON.parse(typeof config.data === 'string' ? config.data : Buffer.from(config.data).toString('utf8')));
    // Publish configuration last; recovery rolls back an interrupted first run.
    changes.sort((a, b) => Number(a.path === 'journal.config.json') - Number(b.path === 'journal.config.json'));
    return { changes, result: true };
  }, observe);
}

export interface BrowserCommand {
  cmd: string;
  args: string[];
  /** True when the command is a Chromium `--app` window rather than a tab. */
  app: boolean;
}

const WINDOWS_CHROMIUM = [
  ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['Chromium', 'Application', 'chrome.exe'],
  ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
];

const MAC_CHROMIUM = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const LINUX_CHROMIUM = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];

/** Path of an installed Chromium-family browser, or null. */
export function findChromium(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter((r): r is string => !!r);
    for (const parts of WINDOWS_CHROMIUM) {
      for (const root of roots) {
        const p = join(root, ...parts);
        if (existsSync(p)) return p;
      }
    }
    return null;
  }
  if (platform === 'darwin') {
    return MAC_CHROMIUM.find((p) => existsSync(p)) ?? null;
  }
  const dirs = (env['PATH'] ?? '').split(':').filter(Boolean);
  for (const name of LINUX_CHROMIUM) {
    for (const d of dirs) {
      const p = join(d, name);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // not there
      }
    }
  }
  return null;
}

/**
 * Command that opens `url`. With `app` and a Chromium browser available,
 * a chromeless window with its own profile under the journal, so it does
 * not share tabs or state with the user's normal browsing.
 */
export function openCommand(
  url: string,
  opts: { app: boolean; journalDir: string; platform?: NodeJS.Platform; chromium?: string | null },
): BrowserCommand {
  const platform = opts.platform ?? process.platform;
  const chromium = opts.chromium === undefined ? findChromium(platform) : opts.chromium;
  if (opts.app && chromium) {
    return {
      cmd: chromium,
      args: [`--app=${url}`, `--user-data-dir=${join(opts.journalDir, '.app-profile')}`, '--no-first-run', '--no-default-browser-check'],
      app: true,
    };
  }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url], app: false };
  if (platform === 'darwin') return { cmd: 'open', args: [url], app: false };
  return { cmd: 'xdg-open', args: [url], app: false };
}

export function openUrl(url: string, opts: { app: boolean; journalDir: string }): BrowserCommand {
  const command = openCommand(url, opts);
  const child = spawn(command.cmd, command.args, { detached: !command.app, stdio: 'ignore' });
  child.on('error', () => {
    console.warn(`Could not open a browser. Open ${url} yourself.`);
  });
  if (!command.app) child.unref();
  return command;
}

/** Number of lesson files across a journal, for the first-run message. */
export function countLessons(journalDir: string): number {
  if (!existsSync(journalDir)) return 0;
  let n = 0;
  for (const entry of readdirSync(journalDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    n += readdirSync(join(journalDir, entry.name)).filter((f) => f.endsWith('.json') && !f.startsWith('_')).length;
  }
  return n;
}
