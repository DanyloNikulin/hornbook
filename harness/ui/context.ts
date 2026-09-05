import type { BrowserContext, Locator, Page, Response } from 'playwright-core';
import type { Report } from '../lib.ts';

export interface UiScenario {
  r: Report;
  page: Page;
  pageErrors: string[];
  context: BrowserContext;
  base: string;
  screens: string;
  ollamaUp: boolean;
  shot: (name: string) => Promise<Buffer>;
  goto: (path: string) => Promise<Response | null>;
  seen: (text: string | RegExp, timeout?: number) => Promise<Locator>;
  body: () => Promise<string>;
  axeViolations: () => Promise<{ id: string; impact: string | null; targets: string[] }[]>;
}
