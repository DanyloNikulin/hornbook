import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { throwawayJournal, startServer } from './lib.ts';

const owned = new Set<string>();
afterEach(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  owned.clear();
});

describe('harness fixture ownership', () => {
  it('allocates independent journals instead of deleting a previous run', () => {
    const name = `ownership-${randomUUID()}`;
    const first = throwawayJournal(name);
    owned.add(first);
    mkdirSync(join(first, 'ja-en'));
    writeFileSync(join(first, 'ja-en', 'lesson.json'), 'keep exactly');
    const second = throwawayJournal(name);
    owned.add(second);
    expect(readFileSync(join(first, 'ja-en', 'lesson.json'), 'utf8')).toBe('keep exactly');
    expect(second).not.toBe(first);
  });

  it('refuses external UI mode before any request or fixture cleanup', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end('{}');
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    try {
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', 'harness/ui.ts'], {
            env: {
              ...process.env,
              HORNBOOK_UI: `http://127.0.0.1:${address.port}`,
              HORNBOOK_BROWSER: 'not-a-browser',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let output = '';
          child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
          child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
          child.once('error', reject);
          child.once('exit', (code) => resolve({ code, output }));
        },
      );
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/external.*disabled/i);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20000);

  it('does not attach to an unrelated server occupying the harness port', async () => {
    const dir = throwawayJournal(`port-${randomUUID()}`);
    owned.add(dir);
    const foreign = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ journal: '/some-other-journal' }));
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => foreign.once('listening', resolve));
    try {
      const port = (foreign.address() as { port: number }).port;
      await expect(startServer({ journal: dir, port })).rejects.toThrow(/did not come up|unowned/i);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  }, 20000);
});
