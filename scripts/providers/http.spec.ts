import { afterEach, expect, it, vi } from 'vitest';
import { postJson } from './http.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('bounds a stalled connection without retrying a timeout', async () => {
  const fetch = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal('fetch', fetch);
  await expect(postJson('http://fixture', {}, {}, 'fixture', 1, (response) => response.json(), { timeoutMs: 20 })).rejects.toThrow('timed out');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([false, true])('releases its timer and unread body when the consumer skips it (throws=%s)', async (throws) => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const request = postJson('http://fixture', {}, {}, 'fixture', 1, async (reply) => {
    if (throws) throw new Error('consumer failed');
    return reply.status;
  });
  if (throws) await expect(request).rejects.toThrow('consumer failed'); else expect(await request).toBe(200);
  expect(vi.getTimerCount()).toBe(0); expect(cancel).toHaveBeenCalledTimes(1);
});
it('keeps the deadline active while the response body stalls', async () => {
  let body!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(controller) { body = controller; } }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(postJson('http://fixture', {}, {}, 'fixture', 1, (response) => response.json(), { timeoutMs: 20 })).rejects.toThrow('timed out');
  body.close();
});
it('cancels retry backoff before sending another request', async () => {
  const controller = new AbortController();
  const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
  vi.stubGlobal('fetch', fetch);
  const request = postJson('http://fixture', {}, {}, 'fixture', 1000, (response) => response.json(), { signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort(new Error('cancel fixture'));
  await expect(request).rejects.toThrow('cancel fixture');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not retry an HTTP error and consumes its body inside the deadline', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const result = await postJson('http://fixture', {}, {}, 'fixture', 1, async (response) => ({ status: response.status, body: await response.text() }));
  expect(result).toEqual({ status: 503, body: 'busy' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
