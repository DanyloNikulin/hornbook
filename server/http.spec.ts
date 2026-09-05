import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMutationOrigin, requestBoundary, sendJson, streamFile } from './http.ts';

function mutation(origin: string, host = 'localhost:4200'): IncomingMessage {
  return { method: 'PUT', headers: { origin, host } } as IncomingMessage;
}

describe('origin policy', () => {
  it('supports the development proxy and an unset public origin', () => {
    expect(() => checkMutationOrigin(mutation('http://localhost:4200'), '')).not.toThrow();
  });
  it('requires an explicit public origin for a TLS proxy', () => {
    const req = mutation('https://lessons.example.com', '127.0.0.1:8787');
    req.headers['x-forwarded-proto'] = 'https';
    req.headers['x-forwarded-host'] = 'lessons.example.com';
    expect(() => checkMutationOrigin(req)).toThrow(/Cross-origin/);
    expect(() => checkMutationOrigin(req, 'https://lessons.example.com')).not.toThrow();
    expect(() =>
      checkMutationOrigin(mutation('https://foreign.example'), 'https://lessons.example.com'),
    ).toThrow();
  });
});

describe('stream errors', () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  });
  it('contains a failed file stream and serves the next request', async () => {
    root = mkdtempSync(join(tmpdir(), 'hornbook-stream-'));
    server = createServer(
      requestBoundary(async (req, res) => {
        if (req.url === '/missing') {
          res.writeHead(200);
          await streamFile(join(root, 'missing'), res);
        } else sendJson(res, 200, { ok: true });
      }),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(fetch(`${base}/missing`).then((res) => res.text())).rejects.toThrow();
    expect((await fetch(`${base}/ok`)).status).toBe(200);
  });
});
