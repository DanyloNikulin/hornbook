#!/usr/bin/env node
// Local-only ingest: write JSON or run process.ts. Binds 127.0.0.1.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Lesson } from '../src/lib/schema.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env['INGEST_PORT'] ?? 8787);

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'http://localhost:4200',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function runProcess(input: string, date: string, from: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(repoRoot, 'scripts', 'process.ts'), input, '--date', date, '--from', from],
      { cwd: repoRoot, env: process.env },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }
  if (req.method !== 'POST' || req.url !== '/ingest') {
    send(res, 404, { error: 'POST /ingest only' });
    return;
  }

  try {
    const raw = JSON.parse((await readBody(req)).toString('utf8')) as {
      kind?: string;
      date?: string;
      lesson?: unknown;
      filename?: string;
      base64?: string;
      from?: string;
    };
    const date = raw.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      send(res, 400, { error: 'date YYYY-MM-DD required' });
      return;
    }

    if (raw.kind === 'json') {
      const parsed = Lesson.safeParse(raw.lesson);
      if (!parsed.success) {
        send(res, 400, { error: 'invalid lesson', details: parsed.error.format() });
        return;
      }
      const dir = join(repoRoot, 'lessons');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${parsed.data.id}.json`);
      writeFileSync(path, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
      send(res, 200, { ok: true, path: `lessons/${parsed.data.id}.json` });
      return;
    }

    if (raw.kind === 'file' && raw.base64 && raw.filename) {
      const ext = extname(raw.filename).toLowerCase() || '.bin';
      const tmp = join(tmpdir(), `lj-${randomBytes(6).toString('hex')}${ext}`);
      writeFileSync(tmp, Buffer.from(raw.base64, 'base64'));
      const from = raw.from ?? 'video';
      const result = await runProcess(tmp, date, from);
      send(res, result.code === 0 ? 200 : 500, {
        ok: result.code === 0,
        log: result.out.slice(-4000),
      });
      return;
    }

    send(res, 400, { error: 'kind json|file required' });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
});

if (!existsSync(join(repoRoot, 'journal.config.json'))) {
  console.error('journal.config.json missing');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Ingest listening on http://${HOST}:${PORT}/ingest`);
  console.log('SPA: ng serve (localhost:4200). Drop files on /compose.');
});
