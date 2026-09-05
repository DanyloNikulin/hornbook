import { setTimeout as pause } from 'node:timers/promises';

export interface ExtractHttpOptions { signal?: AbortSignal; timeoutMs?: number }

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** One deadline spans connection, the single transport retry, and body consumption. */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  who: string,
  retryPauseMs: number,
  consume: (response: Response) => Promise<T>,
  options: ExtractHttpOptions = {},
): Promise<T> {
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Extract ${who} timed out`)), options.timeoutMs ?? 8 * 60 * 1000);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload, signal };
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    try {
      try { response = await abortable(fetch(url, init), signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof TypeError)) throw error;
        await pause(retryPauseMs, undefined, { signal });
        response = await abortable(fetch(url, init), signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`Extract ${who}: cannot reach ${url} (${cause?.code ?? cause?.message ?? (error as Error).message}).`, { cause: error });
    }
    return await abortable(consume(response), signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}
