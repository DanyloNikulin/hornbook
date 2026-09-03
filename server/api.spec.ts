import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { startServer } from './main.ts';
import { setJournalDir } from '../scripts/lib/journal.ts';

// A real server on an ephemeral port, driven with fetch. Static serving is
// off (--no-static equivalent) so no build is needed.
let dir: string;
let base: string;
let server: ReturnType<typeof startServer>;

// 1×1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  return (await res.json()) as T;
}

function post(bodyObj: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hornbook-api-'));
  server = startServer({ port: 0, host: '127.0.0.1', journal: dir, dist: join(dir, 'nodist'), serveStatic: false, password: undefined });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await json('/api/sections', post({ target: 'it', learner: 'en' }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setJournalDir(process.cwd());
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('API — sections and errors', () => {
  it('lists the created section', async () => {
    const config = await json<{ sections: { id: string; label: string }[] }>('/api/config');
    expect(config.sections.map((s) => s.id)).toEqual(['it-en']);
    expect(config.sections[0].label).toBe('Italian → English');
  });

  it('maps store errors onto status codes', async () => {
    expect((await api('/api/sections/nope/lessons')).status).toBe(404);
    expect((await api('/api/config', { method: 'DELETE' })).status).toBe(405);
    expect((await api('/api/nothing-here')).status).toBe(404);
    expect((await api('/api/sections/it-en/lessons', post({ id: 'x' }))).status).toBe(400);
    expect((await api('/api/sections/it-en/jobs', post({ kind: 'nope' }))).status).toBe(400);
  });
});

describe('API — backdrop image', () => {
  it('404s until an image is uploaded', async () => {
    expect((await api('/api/sections/it-en/backdrop')).status).toBe(404);
  });

  it('stores, serves and deletes the image without disturbing the response', async () => {
    const saved = await json<{ theme?: { backdrop?: string } }>(
      '/api/sections/it-en/backdrop',
      post({ filename: 'photo.png', base64: PNG_BASE64 }, 'PUT'),
    );
    expect(saved.theme?.backdrop).toBe('_backdrop.png');
    expect(existsSync(join(dir, 'it-en', '_backdrop.png'))).toBe(true);

    // Streaming the file must not be followed by a JSON body — the bug this
    // route had once crashed the whole server.
    const res = await api('/api/sections/it-en/backdrop');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(Buffer.from(PNG_BASE64, 'base64').length);
    expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);

    // The server is still alive after streaming.
    expect((await api('/api/mode')).status).toBe(200);

    const removed = await json<{ theme?: { backdrop?: string } }>('/api/sections/it-en/backdrop', { method: 'DELETE' });
    expect(removed.theme?.backdrop).toBeUndefined();
    expect(existsSync(join(dir, 'it-en', '_backdrop.png'))).toBe(false);
    expect((await api('/api/sections/it-en/backdrop')).status).toBe(404);
  });

  it('rejects an unsupported file type and an empty image', async () => {
    const bad = await api('/api/sections/it-en/backdrop', post({ filename: 'x.exe', base64: PNG_BASE64 }, 'PUT'));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('.exe');
    expect((await api('/api/sections/it-en/backdrop', post({ filename: 'x.png', base64: '' }, 'PUT'))).status).toBe(400);
  });

  it('refuses to serve a path escaping the section folder', async () => {
    await json('/api/sections/it-en', post({ theme: { backdrop: '../journal.config.json' } }, 'PATCH'));
    expect((await api('/api/sections/it-en/backdrop')).status).toBe(404);
    await json('/api/sections/it-en', post({ theme: null }, 'PATCH'));
  });
});

describe('API — theme round trip', () => {
  it('stores a preset and clears it again', async () => {
    const set = await json<{ theme?: { preset?: string } }>(
      '/api/sections/it-en',
      post({ theme: { preset: 'sea', display_font: 'manrope' } }, 'PATCH'),
    );
    expect(set.theme).toEqual({ preset: 'sea', display_font: 'manrope' });
    const cleared = await json<{ theme?: unknown }>('/api/sections/it-en', post({ theme: null }, 'PATCH'));
    expect(cleared.theme).toBeUndefined();
  });

  it('rejects a colour that is not a hex value', async () => {
    const res = await api('/api/sections/it-en', post({ theme: { primary: 'red' } }, 'PATCH'));
    expect(res.status).toBe(400);
  });
});

describe('API — pipeline probe', () => {
  it('rejects a body without a job', async () => {
    const res = await api('/api/settings/probe', post({ driver: 'openai', model: 'gpt-4o' }));
    expect(res.status).toBe(400);
  });

  it('fails a whisper check when no binary is configured', async () => {
    const body = await json<{ ok: boolean; detail: string }>(
      '/api/settings/probe',
      post({ job: 'transcribe', driver: 'whisper-cli', model: 'ggml-base.bin' }),
    );
    expect(body.ok).toBe(false);
    expect(body.detail).toMatch(/binary/i);
  });
});
