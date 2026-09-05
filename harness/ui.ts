// Browser walk of the built app with Playwright driving the Chrome or Edge
// already installed (playwright-core: no browser download). Starts its own
// server on a throwaway copy of the demo journal, serving dist/, so run
// `npm run build` first. Screenshots land in work/harness/screens/.
//
//   npm run harness:ui
//
// Environment:
//   HORNBOOK_BROWSER   playwright channel: chrome (default), msedge, chromium
//   OLLAMA_HOST        the "Find models" step expects a list when Ollama answers here

// The page.evaluate callbacks run inside the browser; the scripts tsconfig
// has no DOM lib, so pull it in for this file.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axe from 'axe-core';
import type { Browser } from 'playwright-core';
import type { JournalConfigT } from '../src/lib/journal-config.ts';
import { settingsScenario } from './ui/settings.ts';
import { studyScenario } from './ui/study.ts';
import { navigationScenario } from './ui/navigation.ts';
import { progressScenario } from './ui/progress.ts';
import { mutationsScenario } from './ui/mutations.ts';
import { keyboardScenario } from './ui/keyboard.ts';
import { appearanceScenario } from './ui/appearance.ts';
import { jobsScenario } from './ui/jobs.ts';
import {
  Report,
  launchBrowser,
  ollamaHostFromEnv,
  outDir,
  reachable,
  readJson,
  repoRoot,
  startServer,
  throwawayJournal,
  type ServerHandle,
} from './lib.ts';

const PORT = Number(process.env['HORNBOOK_HARNESS_PORT'] ?? 8796);
const SCREENS = join(outDir, 'screens');
const SCENARIOS = {
  jobs: jobsScenario,
  keyboard: keyboardScenario,
  appearance: appearanceScenario,
  mutations: mutationsScenario,
  progress: progressScenario,
  settings: settingsScenario,
  study: studyScenario,
  navigation: navigationScenario,
};
type Scenario = keyof typeof SCENARIOS;

async function runScenario(scenario: Scenario): Promise<Report> {
  const r = new Report(`ui-${scenario}`);
  mkdirSync(SCREENS, { recursive: true });

  let base: string;
  let server: ServerHandle | undefined;
  {
    const dist = join(repoRoot, 'dist', 'hornbook', 'browser', 'index.html');
    if (!r.rec('dist/ is built', existsSync(dist), dist)) {
      r.note('info', 'Build first', 'npm run build');
      r.finish();
      return r;
    }
    const journal = throwawayJournal(`ui-${scenario}`, { fromDemo: true });
    const configPath = join(journal, 'journal.config.json');
    const config = readJson<JournalConfigT>(configPath);
    // Keep the demo's extract model: the config schema needs a name, and the
    // button reads "Find models" until a list has arrived anyway.
    config.providers = {
      transcribe: { driver: 'skip', model: '-' },
      extract: config.providers.extract,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    server = await startServer({ journal, port: PORT, serveStatic: true });
    base = server.api;
    r.rec('throwaway server serves the build', true, base);
  }
  const ollamaUp = await reachable(`${ollamaHostFromEnv()}/api/tags`);

  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    r.rec('browser available', false, String(err));
    server?.stop();
    r.finish();
    return r;
  }
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem('hornbook-locale')) localStorage.setItem('hornbook-locale', 'en');
      localStorage.setItem('hornbook-theme', 'day');
      const state = window as Window & {
        __hornbookHidden?: boolean;
        __hornbookNotifications?: { title: string; body: string }[];
      };
      state.__hornbookHidden = false;
      state.__hornbookNotifications = [];
      try {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => state.__hornbookHidden,
        });
      } catch {
        // Reinstalled immediately before the notification check if needed.
      }
      try {
        const notification = Function(
          'title',
          'options',
          'window.__hornbookNotifications.push({ title, body: options && options.body || "" })',
        ) as unknown as typeof Notification;
        Object.defineProperty(notification, 'permission', { value: 'granted' });
        Object.defineProperty(notification, 'requestPermission', {
          value: Function('return Promise.resolve("granted")'),
        });
        Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
      } catch {
        // Reinstalled immediately before the notification check if needed.
      }
    });
    const page = await context.newPage();
    await page.route('**/__harness/axe.js', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: axe.source });
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text());
    });

    const shot = async (name: string) =>
      page.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: true });
    const goto = (path: string) =>
      page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const seen = async (text: string | RegExp, timeout = 10_000) => {
      const loc = page.getByText(text, { exact: false }).first();
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    };
    const body = () => page.locator('body').innerText();
    const axeViolations = async () => {
      await page.addScriptTag({ url: `${base}/__harness/axe.js` });
      return page.evaluate(async () => {
        const api = (
          window as unknown as Window & {
            axe: {
              run: (
                root: Document,
                options: unknown,
              ) => Promise<{
                violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[];
              }>;
            };
          }
        ).axe;
        const result = await api.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
        });
        return result.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          targets: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
        }));
      });
    };

    try {
      await SCENARIOS[scenario]({
        r,
        page,
        pageErrors,
        context,
        base,
        screens: SCREENS,
        ollamaUp,
        shot,
        goto,
        seen,
        body,
        axeViolations,
      });
      const real = pageErrors.filter((e) => !/favicon/i.test(e));
      r.rec('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));
    } catch (err) {
      r.rec('harness runner', false, String(err));
      await shot('zz-crash').catch(() => undefined);
    }
    r.finish({ base, screens: SCREENS });
    return r;
  } finally {
    await browser.close();
    server.stop();
  }
}

async function main(): Promise<void> {
  if (process.env['HORNBOOK_UI'] || process.env['HORNBOOK_API']) {
    throw new Error(
      'External UI harness mode is disabled. Unset HORNBOOK_UI and HORNBOOK_API to use an isolated journal.',
    );
  }
  const report = new Report('ui');
  const selected = process.argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1];
  if (selected && !(selected in SCENARIOS)) throw new Error(`Unknown UI scenario: ${selected}`);
  for (const scenario of (selected ? [selected] : Object.keys(SCENARIOS)) as Scenario[]) {
    const result = await runScenario(scenario);
    report.checks.push(...result.checks);
    report.notes.push(...result.notes);
  }
  report.finish({ screens: SCREENS });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
