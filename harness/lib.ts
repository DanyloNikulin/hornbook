// Shared plumbing for the local harness scripts (see harness/README.md).
// Plain Node, no test framework: a report reads the same in a terminal, a
// CI log or an agent's tool output, and every script leaves a JSON copy
// under work/harness/.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright-core';
import type { JobView } from '../src/lib/api-types.ts';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
export const fixturesDir = join(repoRoot, 'harness', 'fixtures');
export const outDir = join(repoRoot, 'work', 'harness');

export interface Check {
  name: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
}

export interface Note {
  severity: 'bug' | 'info';
  title: string;
  detail: string;
}

/** Collects PASS / FAIL / SKIP lines and writes them as JSON at the end. */
export class Report {
  readonly checks: Check[] = [];
  readonly notes: Note[] = [];

  constructor(readonly name: string) {
    mkdirSync(outDir, { recursive: true });
    console.log(`=== harness ${name} ===`);
  }

  rec(name: string, ok: boolean, detail: unknown = ''): boolean {
    const text = clip(detail);
    this.checks.push({ name, ok, skipped: false, detail: text });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${text ? ' — ' + text : ''}`);
    return ok;
  }

  /** A check that could not run here (tool not installed, model not pulled). Never a failure. */
  skip(name: string, why: unknown): void {
    const text = clip(why);
    this.checks.push({ name, ok: true, skipped: true, detail: text });
    console.log(`SKIP  ${name}${text ? ' — ' + text : ''}`);
  }

  note(severity: Note['severity'], title: string, detail: unknown = ''): void {
    const text = clip(detail);
    this.notes.push({ severity, title, detail: text });
    console.log(`NOTE [${severity}] ${title}${text ? ': ' + text : ''}`);
  }

  section(title: string): void {
    console.log(`\n--- ${title} ---`);
  }

  /** Print the summary, write work/harness/<name>.json, set the exit code. */
  finish(extra: Record<string, unknown> = {}): void {
    const passed = this.checks.filter((c) => c.ok && !c.skipped).length;
    const failed = this.checks.filter((c) => !c.ok).length;
    const skipped = this.checks.filter((c) => c.skipped).length;
    console.log(`\n${this.name}: ${passed} passed, ${failed} failed, ${skipped} skipped, ${this.notes.length} note(s)`);
    const file = join(outDir, `${this.name}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        { name: this.name, at: new Date().toISOString(), passed, failed, skipped, checks: this.checks, notes: this.notes, ...extra },
        null,
        2,
      ) + '\n',
    );
    console.log(`Report: ${file}`);
    if (failed) process.exitCode = 1;
  }
}

function clip(value: unknown): string {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return s.replace(/\s+/g, ' ').trim().slice(0, 600);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export interface Reply {
  status: number;
  json: unknown;
  text: string;
}

export function client(base: string) {
  return async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 400) };
    }
    return { status: res.status, json, text };
  };
}

export type Api = ReturnType<typeof client>;

/** Narrow a reply body without `any` at every call site. */
export function obj(reply: Reply): Record<string, unknown> {
  return reply.json && typeof reply.json === 'object' ? (reply.json as Record<string, unknown>) : {};
}

export async function reachable(url: string, ms = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitJob(api: Api, id: string, ms: number): Promise<JobView | undefined> {
  const start = Date.now();
  let job: JobView | undefined;
  while (Date.now() - start < ms) {
    const g = await api('GET', `/api/jobs/${id}`);
    job = g.json as JobView;
    if (job?.status === 'done' || job?.status === 'failed') return job;
    await sleep(1500);
  }
  return job;
}

export function jobSummary(job: JobView | undefined): string {
  if (!job) return 'no job';
  return `${job.status} slug=${job.result?.slug ?? '-'} ${job.error ? 'error=' + job.error : ''} log…${job.log.slice(-240)}`;
}

// ── Throwaway journal + server ──────────────────────────────────────────────

export interface JournalSeed {
  /** Copy the demo journal (repo journal/) first. */
  fromDemo?: boolean;
  /** Written as journal.config.json (after the copy). */
  config?: unknown;
  /** Written as secrets.json. */
  secrets?: Record<string, string>;
}

/** A fresh journal folder under work/harness/journals/<name>. */
export function throwawayJournal(name: string, seed: JournalSeed = {}): string {
  const dir = join(outDir, 'journals', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (seed.fromDemo) {
    cpSync(join(repoRoot, 'journal'), dir, {
      recursive: true,
      filter: (src) => !/(^|[\\/])(_derived|_progress\.json|_uploads|secrets\.json)$/.test(src),
    });
  }
  if (seed.config !== undefined) {
    writeFileSync(join(dir, 'journal.config.json'), JSON.stringify(seed.config, null, 2) + '\n');
  }
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(seed.secrets ?? {}, null, 2) + '\n');
  return dir;
}

export interface ServerHandle {
  api: string;
  child: ChildProcess;
  log: () => string;
  stop: () => void;
}

export interface ServerOptions {
  journal: string;
  port: number;
  /** Serve dist/ too (the UI walk); default API only. */
  serveStatic?: boolean;
}

/**
 * Start server/main.ts on 127.0.0.1 with cloud keys blanked, so nothing a
 * harness does can reach a paid API even on a machine that has keys in its
 * environment or .env.
 */
export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const args = ['--import', 'tsx', join(repoRoot, 'server', 'main.ts'), '--journal', opts.journal, '--port', String(opts.port), '--host', '127.0.0.1'];
  if (!opts.serveStatic) args.push('--no-static');
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HORNBOOK_PASSWORD: '' },
  });
  let log = '';
  child.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (log += d.toString()));
  const api = `http://127.0.0.1:${opts.port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    if (await reachable(`${api}/api/mode`, 1000)) {
      return { api, child, log: () => log, stop: () => child.kill() };
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`Server on ${api} did not come up.\n${log.slice(-800)}`);
}

// ── Small helpers ───────────────────────────────────────────────────────────

// ── Browser ─────────────────────────────────────────────────────────────────

/** The Chrome or Edge already installed, headless (playwright-core: no download). */
export async function launchBrowser(): Promise<Browser> {
  const wanted = process.env['HORNBOOK_BROWSER'];
  const channels = wanted ? [wanted] : ['chrome', 'msedge', 'chromium'];
  let last: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`No browser could be launched (tried ${channels.join(', ')}). ${String(last).split('\n')[0]}`);
}

export function b64(file: string): string {
  return readFileSync(file).toString('base64');
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function exists(path: string | undefined): path is string {
  return !!path && existsSync(path);
}

/** Run a program to completion; resolves with exit code and combined output. */
export function run(cmd: string, args: string[], cwd = repoRoot): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (err) => resolve({ code: null, out: out + String(err) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

export function ollamaHostFromEnv(): string {
  return (process.env['OLLAMA_HOST']?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '');
}
