import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let child: ChildProcess;
let port: number;
function call(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body = '',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
    req.end(body);
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-http-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'index.html'), '<html>Fixture</html>');
  // The child reports the assigned port, keeping crash regressions isolated.
  const entry = `import { startServer } from './server/main.ts'; const s = startServer({port:0,host:'127.0.0.1',journal:process.env.FIXTURE_JOURNAL,dist:process.env.FIXTURE_DIST,serveStatic:true,password:undefined}); s.on('listening',()=>console.log('PORT='+s.address().port));`;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', entry], {
    env: {
      ...process.env,
      HORNBOOK_TOOLS: join(root, 'tools'),
      FIXTURE_JOURNAL: join(root, 'journal'),
      FIXTURE_DIST: join(root, 'dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 15000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}`));
    });
    child.stdout!.on('data', (data: Buffer) => {
      const match = /PORT=(\d+)/.exec(data.toString());
      if (match) {
        port = Number(match[1]);
        clearTimeout(timer);
        resolve();
      }
    });
  });
}, 20000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await closed;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('HTTP request boundary', () => {
  it('rejects foreign and opaque origins, including bodyless mutations', async () => {
    for (const origin of ['https://foreign.example', 'null']) {
      expect(
        await call(
          '/api/sections',
          'POST',
          { Origin: origin, 'Content-Type': 'text/plain' },
          '{"target":"es","learner":"en"}',
        ),
      ).toBe(403);
      expect(await call('/api/sections/es-en', 'DELETE', { Origin: origin })).toBe(403);
    }
  });
  it('requires JSON and permits same-origin JSON and non-browser clients', async () => {
    expect(await call('/api/settings', 'PUT', { 'Content-Type': 'text/plain' }, '{}')).toBe(415);
    expect(
      await call(
        '/api/settings',
        'PUT',
        { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        '{}',
      ),
    ).toBe(200);
    expect(await call('/api/settings', 'PUT', { 'Content-Type': 'application/json' }, '{}')).toBe(
      200,
    );
  });
  it('rejects large settings and progress bodies before buffering them', async () => {
    for (const path of ['/api/settings', '/api/sections/es-en/progress']) {
      expect(
        await call(path, 'PUT', {
          'Content-Type': 'application/json',
          'Content-Length': '536870912',
        }),
      ).toBe(413);
    }
  });
  it('enforces the limit on chunked bodies and leaves the server usable', async () => {
    expect(
      await call(
        '/api/settings',
        'PUT',
        { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        'x'.repeat(1024 * 1024 + 1),
      ),
    ).toBe(413);
    expect(await call('/api/config')).toBe(200);
  });
  it('rejects browser cross-site metadata and unknown local hosts', async () => {
    expect(
      await call(
        '/api/settings',
        'PUT',
        { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
        '{}',
      ),
    ).toBe(403);
    expect(await call('/api/config', 'GET', { Host: 'foreign.example' })).toBe(403);
  });
  it('keeps uploads separate from small job requests', async () => {
    expect(
      await call(
        '/api/sections',
        'POST',
        { 'Content-Type': 'application/json' },
        '{"target":"it","learner":"en"}',
      ),
    ).toBe(201);
    expect(
      await call('/api/sections/it-en/jobs', 'POST', {
        'Content-Type': 'application/json',
        'Content-Length': '2097152',
      }),
    ).toBe(413);
    expect(
      await call(
        '/api/sections/it-en/uploads',
        'POST',
        { 'Content-Type': 'application/json' },
        '{"kind":"cheatsheet"}',
      ),
    ).toBe(400);
  });
  it.each(['..%2Foutside', '..%5Coutside', '%252e%252e%252foutside', 'unknown'])(
    'rejects encoded section %s before writes',
    async (id) => {
      expect(
        await call(
          `/api/sections/${id}/backdrop`,
          'PUT',
          { 'Content-Type': 'application/json' },
          '{"filename":"x.png","base64":"YWJj"}',
        ),
      ).toBe(404);
    },
  );
  it('returns 400 for malformed static and API paths and remains available', async () => {
    for (const path of ['/%', '/api/sections/%/lessons', '/%00']) {
      expect(await call(path)).toBe(400);
      expect(await call('/api/config')).toBe(200);
    }
  });
});
