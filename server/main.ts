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
import { createApi, sendJson } from './api.ts';
import { FolderStore } from './store.ts';
import { JobRunner } from './jobs.ts';
import { pipelineEnv } from './secrets.ts';
import { isMain } from '../scripts/lib/is-main.ts';
import { challenge, isAuthorized, isLaunchAuthorized } from './auth.ts';
import { ManagedOllama } from './managed-ollama.ts';
import { createSetup } from './setup.ts';
import { DEFAULT_MANAGED_OLLAMA_PORT, managedPaths, toolsDir } from '../scripts/lib/tools.ts';
import { packageRoot, packageVersion } from '../scripts/lib/runtime.ts';
import { ReleaseChecker } from './releases.ts';
import type { JobView } from '../src/lib/api-types.ts';

const repoRoot = packageRoot(import.meta.url);
const APP_VERSION = packageVersion(repoRoot);

export interface Options {
  port: number;
  host: string;
  journal: string | undefined;
  dist: string;
  serveStatic: boolean;
  /** Basic-auth password for hosted mode; undefined = open (local). */
  password: string | undefined;
  /** Per-launch secret used by the Electron renderer on every request. */
  token?: string;
  shell?: 'browser' | 'electron';
  version?: string;
  releasesUrl?: string;
  updates?: ReleaseChecker;
  /** Compiled scripts in a packaged app; source mode uses tsx. */
  scriptDir?: string;
  childEnv?: NodeJS.ProcessEnv;
  childCwd?: string;
  workDir?: string;
  onJobFinish?: (job: JobView) => void;
  onJobsChanged?: (active: number) => void;
}

export function parseArgs(argv: readonly string[]): Options {
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
    password: get('--password') ?? process.env['HORNBOOK_PASSWORD'] ?? undefined,
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

// Sent with every HTML response. The UI loads scripts, styles and fonts only
// from itself, talks only to its own origin, and cannot be framed.
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

export function startServer(opts: Options): ReturnType<typeof createServer> {
  const store = new FolderStore(opts.journal);
  const mode = opts.host === '127.0.0.1' || opts.host === 'localhost' ? 'local' : 'hosted';
  const tools = managedPaths(toolsDir());
  const managed = new ManagedOllama({
    exe: tools.ollama,
    modelsDir: tools.ollamaModels,
    port: Number(process.env['HORNBOOK_OLLAMA_PORT'] ?? DEFAULT_MANAGED_OLLAMA_PORT),
    log: (line) => console.log(line),
  });
  const jobs = new JobRunner({
    repoRoot,
    cwd: opts.childCwd,
    journalDir: () => store.dir,
    env: () => ({
      ...pipelineEnv(store.dir),
      ...opts.childEnv,
      ...(opts.workDir ? { HORNBOOK_WORK: opts.workDir } : {}),
      HORNBOOK_APP_ROOT: repoRoot,
    }),
    ...(opts.scriptDir
      ? {
          runner: (script: string) => ({
            cmd: process.execPath,
            args: [join(opts.scriptDir as string, script.replace(/\.ts$/, '.js'))],
          }),
        }
      : {}),
    onChange: opts.onJobsChanged,
    // A freshly downloaded managed Ollama comes up at once, so the model
    // pull queued behind it finds a server.
    onFinish: (job) => {
      if (job.kind === 'setup' && job.status === 'done' && job.result?.tool === 'ollama') void setup.bootManagedOllama();
      opts.onJobFinish?.(job);
    },
  });
  const setup = createSetup({ journalDir: () => store.dir, pipelineEnv: () => pipelineEnv(store.dir), jobs, managed });
  const version = opts.version ?? APP_VERSION;
  const updates = opts.updates ?? new ReleaseChecker({
    currentVersion: version,
    url: opts.releasesUrl ?? process.env['HORNBOOK_RELEASES_URL'],
  });
  const api = createApi({ store, jobs, setup, mode, shell: opts.shell ?? 'browser', version, updates });
  const distRoot = opts.dist;
  const hasDist = opts.serveStatic && existsSync(join(distRoot, 'index.html'));

  if (opts.serveStatic && !hasDist) {
    console.warn(`No build at ${distRoot} — run "npm run build" first, or use --no-static with ng serve.`);
  }

  if (mode === 'hosted' && !opts.password) {
    console.warn('Listening on a non-local address with no --password. Anyone who can reach this port can read and write the journal.');
  }

  const server = createServer(async (req, res) => {
    if (opts.token && !isLaunchAuthorized(req, opts.token)) {
      sendJson(res, 401, { error: 'Hornbook launch token required' });
      return;
    }
    if (opts.password && !isAuthorized(req, opts.password)) {
      challenge(res);
      return;
    }
    try {
      if (await api(req, res)) return;
    } catch (err) {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: (err as Error).message });
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
      ...(ext === '.html' ? SECURITY_HEADERS : {}),
    });
    createReadStream(filePath).pipe(res);
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`Hornbook ${mode} server on http://${opts.host}:${opts.port}${opts.password ? ' (password protected)' : ''}`);
    console.log(`Journal: ${store.dir}`);
    if (hasDist) console.log(`UI: ${distRoot}`);
    void setup.bootManagedOllama();
  });
  server.on('close', () => {
    jobs.stop();
    managed.stop();
  });
  process.once('exit', () => {
    jobs.stop();
    managed.stop();
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      jobs.stop();
      managed.stop();
      process.exit(0);
    });
  }
  return server;
}

if (isMain(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2)));
}
