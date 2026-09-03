#!/usr/bin/env node
// Hornbook server: serves the built UI and the API over the journal folder.
//
//   tsx server/main.ts                       # 127.0.0.1:8787, dist/hornbook/browser, ./journal
//   tsx server/main.ts --journal ~/Hornbook  # another folder
//   tsx server/main.ts --no-static           # API only (ng serve proxies /api in dev)
//   tsx server/main.ts --host 0.0.0.0 --port 80  # hosted: put an access proxy in front
//
// Env: HORNBOOK_JOURNAL, HORNBOOK_PORT, HORNBOOK_HOST.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, sendJson } from './api.ts';
import { FolderStore } from './store.ts';
import { JobRunner } from './jobs.ts';
import { pipelineEnv } from './secrets.ts';
import { isMain } from '../scripts/lib/is-main.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

interface Options {
  port: number;
  host: string;
  journal: string | undefined;
  dist: string;
  serveStatic: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    port: Number(get('--port') ?? process.env['HORNBOOK_PORT'] ?? 8787),
    host: get('--host') ?? process.env['HORNBOOK_HOST'] ?? '127.0.0.1',
    journal: get('--journal') ?? process.env['HORNBOOK_JOURNAL'],
    dist: resolve(get('--dist') ?? join(repoRoot, 'dist', 'hornbook', 'browser')),
    serveStatic: !argv.includes('--no-static'),
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export function startServer(opts: Options): ReturnType<typeof createServer> {
  const store = new FolderStore(opts.journal);
  const mode = opts.host === '127.0.0.1' || opts.host === 'localhost' ? 'local' : 'hosted';
  const jobs = new JobRunner({
    repoRoot,
    journalDir: () => store.dir,
    env: () => pipelineEnv(store.dir),
  });
  const api = createApi({ store, jobs, mode });
  const distRoot = opts.dist;
  const hasDist = opts.serveStatic && existsSync(join(distRoot, 'index.html'));

  if (opts.serveStatic && !hasDist) {
    console.warn(`No build at ${distRoot} — run "npm run build" first, or use --no-static with ng serve.`);
  }

  const server = createServer(async (req, res) => {
    try {
      if (await api(req, res)) return;
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
      return;
    }

    if (!hasDist) {
      sendJson(res, 404, { error: 'UI not built. Run "npm run build".' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const cleanPath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(distRoot, cleanPath);
    // Never leave the dist folder.
    if (!filePath.startsWith(distRoot + sep) && filePath !== distRoot) {
      sendJson(res, 400, { error: 'Bad path' });
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA fallback: unknown paths without a file extension render the app.
      if (extname(cleanPath) && cleanPath !== '/') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      filePath = join(distRoot, 'index.html');
    }
    const ext = extname(filePath).toLowerCase();
    const hashed = /\.[0-9A-Z]{8,}\.(js|css)$/i.test(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`Hornbook ${mode} server on http://${opts.host}:${opts.port}`);
    console.log(`Journal: ${store.dir}`);
    if (hasDist) console.log(`UI: ${distRoot}`);
  });
  return server;
}

if (isMain(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2)));
}
