// HTTP API over the FolderStore. Small and explicit; every route is listed
// here. Bodies are JSON. Errors are `{ error, details? }` with a status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FolderStore, HttpError, type DerivedKind } from './store.ts';
import type { JobRunner } from './jobs.ts';
import type { StartJob } from '../src/lib/api-types.ts';

const MAX_BODY_BYTES = 512 * 1024 * 1024; // base64 uploads of lesson video

export interface ApiContext {
  store: FolderStore;
  jobs: JobRunner;
  mode: 'local' | 'hosted';
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: () => Promise<unknown>) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${source}/?$`), keys };
}

export function createApi(ctx: ApiContext): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler): void => {
    const { pattern, keys } = compile(path);
    routes.push({ method, pattern, keys, handler });
  };
  const { store } = ctx;

  on('GET', '/api/mode', () => ({ mode: ctx.mode, journal: store.dir }));
  on('GET', '/api/config', () => store.config());

  on('POST', '/api/sections', async (_r, _s, _p, body) => store.createSection(await body()));
  on('PATCH', '/api/sections/:id', async (_r, _s, p, body) => store.updateSection(p['id'], await body()));
  on('DELETE', '/api/sections/:id', (_r, _s, p) => {
    store.deleteSection(p['id']);
    return { ok: true };
  });

  on('GET', '/api/sections/:id/lessons', (_r, _s, p) => store.lessonMetas(p['id']));
  on('POST', '/api/sections/:id/lessons', async (_r, _s, p, body) => store.saveLesson(p['id'], await body()));
  on('GET', '/api/sections/:id/lessons/:slug', (_r, _s, p) => store.lesson(p['id'], p['slug']));
  on('PUT', '/api/sections/:id/lessons/:slug', async (_r, _s, p, body) => {
    const raw = (await body()) as Record<string, unknown>;
    if (raw && typeof raw === 'object' && raw['slug'] !== p['slug']) {
      throw new HttpError(400, `Body slug "${String(raw['slug'])}" does not match URL slug "${p['slug']}"`);
    }
    return store.saveLesson(p['id'], raw);
  });
  on('DELETE', '/api/sections/:id/lessons/:slug', (_r, _s, p) => {
    store.deleteLesson(p['id'], p['slug']);
    return { ok: true };
  });

  for (const kind of ['vocab', 'cards', 'search-index'] as DerivedKind[]) {
    on('GET', `/api/sections/:id/${kind}`, (_r, res, p) => {
      const text = store.derived(p['id'], kind);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
      return undefined;
    });
  }
  on('GET', '/api/sections/:id/cheatsheet', (_r, _s, p) => store.cheatsheet(p['id']));

  on('GET', '/api/sections/:id/progress', (_r, _s, p) => store.progress(p['id']));
  on('PUT', '/api/sections/:id/progress', async (_r, _s, p, body) => store.saveProgress(p['id'], await body()));

  // Settings: journal-level provider defaults + connection values.
  on('GET', '/api/settings', () => store.settings());
  on('PUT', '/api/settings', async (_r, _s, _p, body) => store.updateSettings(await body()));

  // Jobs: the pipeline scripts run as child processes, one at a time.
  on('POST', '/api/sections/:id/jobs', async (_r, _s, p, body) => {
    store.section(p['id']);
    const input = (await body()) as Partial<StartJob>;
    if (!input || typeof input !== 'object' || !isStartJob(input)) {
      throw new HttpError(400, 'Invalid job request');
    }
    return ctx.jobs.enqueue(p['id'], input);
  });
  on('GET', '/api/sections/:id/jobs', (_r, _s, p) => {
    store.section(p['id']);
    return ctx.jobs.list(p['id']);
  });
  on('GET', '/api/jobs/:id', (_r, _s, p) => {
    const job = ctx.jobs.get(p['id']);
    if (!job) throw new HttpError(404, `No job "${p['id']}"`);
    return job;
  });

  on('GET', '/api/sections/:id/files', (_r, _s, p) => store.listFiles(p['id']));

  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    const method = (req.method ?? 'GET').toUpperCase();

    let matched: Route | null = null;
    let params: Record<string, string> = {};
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      matched = r;
      params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      break;
    }

    if (!matched) {
      sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : `No route ${method} ${url.pathname}` });
      return true;
    }

    const body = (): Promise<unknown> => readJson(req);
    try {
      const result = await matched.handler(req, res, params, body);
      if (!res.writableEnded) sendJson(res, method === 'POST' && url.pathname === '/api/sections' ? 201 : 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, details: err.details });
      } else {
        const e = err as Error;
        console.error(`[api] ${method} ${url.pathname}:`, e.stack ?? e.message);
        sendJson(res, 500, { error: e.message });
      }
    }
    return true;
  };
}

function isStartJob(input: Partial<StartJob>): input is StartJob {
  switch (input.kind) {
    case 'process':
      return (
        typeof input.filename === 'string' &&
        input.filename.length > 0 &&
        typeof input.base64 === 'string' &&
        input.base64.length > 0 &&
        typeof input.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(input.date) &&
        (input.from === undefined || ['video', 'audio', 'transcript', 'json'].includes(input.from))
      );
    case 'cheatsheet':
      return input.force === undefined || typeof input.force === 'boolean';
    case 'review-topics':
      return true;
    default:
      return false;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
