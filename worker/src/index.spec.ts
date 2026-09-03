import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dispatcher, {
  SAFE_R2_KEY,
  CREATE_ACTIONS,
  isRetryableStatus,
  GitHubDispatchError,
  DISPATCH_TIMEOUT_MS,
  uploadIdentity,
  UploadDedup,
  CLAIM_LEASE_MS,
} from './index';

// -----------------------------------------------------------------------------
// SAFE_R2_KEY — security boundary
// -----------------------------------------------------------------------------

describe('SAFE_R2_KEY — safe keys pass', () => {
  it('accepts ISO-dated mp4', () => {
    expect(SAFE_R2_KEY.test('2026-05-01-topic.mp4')).toBe(true);
  });

  it('accepts m4a with spaces', () => {
    expect(SAFE_R2_KEY.test('lesson with spaces.m4a')).toBe(true);
  });

  it('accepts Unicode (Cyrillic) letters', () => {
    expect(SAFE_R2_KEY.test('урок.mp3')).toBe(true);
  });

  it('accepts each supported extension', () => {
    for (const ext of ['mp4', 'm4a', 'mp3', 'wav', 'opus', 'ogg', 'webm', 'mov']) {
      expect(SAFE_R2_KEY.test(`file.${ext}`)).toBe(true);
    }
  });

  it('accepts extension case-insensitively', () => {
    expect(SAFE_R2_KEY.test('file.MP4')).toBe(true);
    expect(SAFE_R2_KEY.test('file.M4A')).toBe(true);
  });

  it('accepts parens, commas, apostrophes (safe shell chars inside double quotes)', () => {
    expect(SAFE_R2_KEY.test("L'opera (parte 1), bis.mp3")).toBe(true);
  });
});

describe('SAFE_R2_KEY — unsafe keys reject', () => {
  it('rejects double-quote (would close shell quoting)', () => {
    expect(SAFE_R2_KEY.test('"injected".mp4')).toBe(false);
  });

  it('rejects dollar sign (shell variable expansion)', () => {
    expect(SAFE_R2_KEY.test('$VAR.mp4')).toBe(false);
  });

  it('rejects backtick (command substitution)', () => {
    expect(SAFE_R2_KEY.test('`cmd`.mp4')).toBe(false);
  });

  it('rejects backslash (shell escape)', () => {
    expect(SAFE_R2_KEY.test('back\\slash.mp4')).toBe(false);
  });

  it('rejects carriage return', () => {
    expect(SAFE_R2_KEY.test('cr\rlf.mp4')).toBe(false);
  });

  it('rejects newline', () => {
    expect(SAFE_R2_KEY.test('lf\n.mp4')).toBe(false);
  });

  it('rejects NUL byte', () => {
    expect(SAFE_R2_KEY.test('nul\x00.mp4')).toBe(false);
  });

  it('rejects missing extension', () => {
    expect(SAFE_R2_KEY.test('nofileext')).toBe(false);
  });

  it('rejects wrong extension (.sh)', () => {
    expect(SAFE_R2_KEY.test('script.sh')).toBe(false);
  });

  it('rejects wrong extension (.txt)', () => {
    expect(SAFE_R2_KEY.test('readme.txt')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(SAFE_R2_KEY.test('')).toBe(false);
  });

  it('rejects bare extension with empty stem', () => {
    expect(SAFE_R2_KEY.test('.mp4')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// CREATE_ACTIONS — R2 event filter
// -----------------------------------------------------------------------------

describe('CREATE_ACTIONS', () => {
  it('contains PutObject', () => {
    expect(CREATE_ACTIONS.has('PutObject')).toBe(true);
  });

  it('contains CompleteMultipartUpload', () => {
    expect(CREATE_ACTIONS.has('CompleteMultipartUpload')).toBe(true);
  });

  it('contains CopyObject', () => {
    expect(CREATE_ACTIONS.has('CopyObject')).toBe(true);
  });

  it('does not contain DeleteObject', () => {
    expect(CREATE_ACTIONS.has('DeleteObject')).toBe(false);
  });

  it('does not contain AbortMultipartUpload', () => {
    expect(CREATE_ACTIONS.has('AbortMultipartUpload')).toBe(false);
  });

  it('does not contain unknown actions', () => {
    expect(CREATE_ACTIONS.has('NotAnAction')).toBe(false);
    expect(CREATE_ACTIONS.has('')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// isRetryableStatus — drop 4xx, retry 5xx and 429
// -----------------------------------------------------------------------------

describe('isRetryableStatus', () => {
  it('returns false for 400 (Bad Request)', () => {
    expect(isRetryableStatus(400)).toBe(false);
  });

  it('returns true for 401 (Unauthorized — auth/config class, goes to DLQ)', () => {
    expect(isRetryableStatus(401)).toBe(true);
  });

  it('returns true for 403 (Forbidden — under-scoped PAT, goes to DLQ)', () => {
    expect(isRetryableStatus(403)).toBe(true);
  });

  it('returns true for 404 (Not Found — GitHub hides private repos the token cannot see)', () => {
    expect(isRetryableStatus(404)).toBe(true);
  });

  it('returns false for 422 (Unprocessable Entity)', () => {
    expect(isRetryableStatus(422)).toBe(false);
  });

  it('returns true for 429 (Too Many Requests — rate limit)', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('returns true for 500 (Internal Server Error)', () => {
    expect(isRetryableStatus(500)).toBe(true);
  });

  it('returns true for 502 (Bad Gateway)', () => {
    expect(isRetryableStatus(502)).toBe(true);
  });

  it('returns true for 503 (Service Unavailable)', () => {
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('returns true for 504 (Gateway Timeout)', () => {
    expect(isRetryableStatus(504)).toBe(true);
  });

  it('returns false for 2xx', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(204)).toBe(false);
  });

  it('returns false for 3xx', () => {
    expect(isRetryableStatus(301)).toBe(false);
    expect(isRetryableStatus(304)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// GitHubDispatchError
// -----------------------------------------------------------------------------

describe('GitHubDispatchError', () => {
  it('carries status and bodyExcerpt', () => {
    const err = new GitHubDispatchError(403, 'forbidden');
    expect(err.status).toBe(403);
    expect(err.bodyExcerpt).toBe('forbidden');
    expect(err.name).toBe('GitHubDispatchError');
    expect(err.message).toContain('403');
    expect(err.message).toContain('forbidden');
    expect(err instanceof Error).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// queue handler — integration
// -----------------------------------------------------------------------------

// Lightweight shape that satisfies the parts of MessageBatch / Message the
// dispatcher actually uses (msg.body, msg.ack(), msg.retry()). We deliberately
// avoid `@cloudflare/workers-types` here so the test stays standalone.
interface FakeMessage {
  body: unknown;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function makeMessage(body: unknown): FakeMessage {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function makeBatch(messages: FakeMessage[]) {
  return { messages, queue: 'test', ackAll: vi.fn(), retryAll: vi.fn() };
}

// Map-backed fake of the Durable Object plumbing. Each makeEnv() call gets a
// fresh namespace, so identities claimed in one test never leak into another
// (many tests deliberately reuse the same key).
class FakeStorage {
  private map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  // The real DO serializes transactions; tests are single-threaded, so just
  // run the closure.
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

function makeDedupNamespace() {
  const objects = new Map<string, UploadDedup>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      let obj = objects.get(id);
      if (!obj) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        obj = new UploadDedup({ storage: new FakeStorage() } as any);
        objects.set(id, obj);
      }
      return {
        fetch: (url: string | URL, init?: RequestInit) => obj!.fetch(new Request(url, init)),
      };
    },
  };
}

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    GITHUB_OWNER: 'owner',
    GITHUB_REPO: 'repo',
    GITHUB_TOKEN: 'token-xyz',
    UPLOAD_DEDUP: makeDedupNamespace(),
    ...extra,
  };
}

function mockFetchResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('queue handler — malformed bodies', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    // Silence the queue handler's console output during these tests so the
    // test runner output stays clean; the dispatcher logs errors on bad input.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acks (no fetch) when body is null', async () => {
    const msg = makeMessage(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('acks (no fetch) when action is missing', async () => {
    const msg = makeMessage({ object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('acks (no fetch) when object.key is missing', async () => {
    const msg = makeMessage({ action: 'PutObject', object: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('acks (no fetch) when action is the wrong type', async () => {
    const msg = makeMessage({ action: 42, object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('queue handler — action filter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips DeleteObject (ack, no fetch)', async () => {
    const msg = makeMessage({ action: 'DeleteObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips unknown action (ack, no fetch)', async () => {
    const msg = makeMessage({ action: 'NotAnAction', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('queue handler — unsafe keys', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a key with a dollar sign (ack, no fetch)', async () => {
    const msg = makeMessage({ action: 'PutObject', object: { key: '$VAR.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drops a key with the wrong extension (ack, no fetch)', async () => {
    const msg = makeMessage({ action: 'PutObject', object: { key: 'script.sh' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('queue handler — successful dispatch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acks and calls fetch with the correct URL, headers, and payload', async () => {
    const msg = makeMessage({
      action: 'PutObject',
      object: { key: '2026-05-01-topic.mp4', size: 12345 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/owner/repo/dispatches');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-xyz');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('hornbook-dispatcher');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      event_type: 'process-lesson',
      client_payload: { r2_key: '2026-05-01-topic.mp4' },
    });
  });

  it('treats 200 as ok', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(200));
    const msg = makeMessage({
      action: 'PutObject',
      object: { key: '2026-05-01-topic.mp4' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('dispatches each CREATE_ACTION', async () => {
    for (const action of ['PutObject', 'CompleteMultipartUpload', 'CopyObject']) {
      fetchSpy.mockClear();
      const msg = makeMessage({ action, object: { key: 'a.mp4' } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });
});

describe('queue handler — GitHub dispatch errors', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on 403 (auth failure — bounded by max_retries, lands in the DLQ)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(403, 'forbidden'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries on 401 (bad token)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(401, 'bad credentials'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries on 404 (repo not visible to the token)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(404, 'not found'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks on 400 (malformed request — our bug, do not retry)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(400, 'bad request'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('acks on 422 (validation, do not retry)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(422, 'validation failed'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries on 500 (server error)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, 'oops'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries on 502 (bad gateway)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(502, 'bad gateway'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries on 429 (rate-limited, transient)', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(429, 'rate limited'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries on network error (fetch rejects)', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('network down'));
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe('queue handler — batch processing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles each message in a mixed batch independently', async () => {
    const ok = makeMessage({ action: 'PutObject', object: { key: 'good.mp4' } });
    const skip = makeMessage({ action: 'DeleteObject', object: { key: 'gone.mp4' } });
    const malformed = makeMessage(null);
    const unsafe = makeMessage({ action: 'PutObject', object: { key: 'bad`.mp4' } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([ok, skip, malformed, unsafe]) as any, makeEnv() as any);

    expect(ok.ack).toHaveBeenCalledTimes(1);
    expect(skip.ack).toHaveBeenCalledTimes(1);
    expect(malformed.ack).toHaveBeenCalledTimes(1);
    expect(unsafe.ack).toHaveBeenCalledTimes(1);

    // Only the safe-and-create message hits the network.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// queue handler — bucket check, key shapes, timeout, isolation
// -----------------------------------------------------------------------------

describe('queue handler — bucket allowlist (R2_BUCKET var)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const makeEnvWithBucket = () => makeEnv({ R2_BUCKET: 'hornbook-audio' });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches when the event bucket matches R2_BUCKET', async () => {
    const msg = makeMessage({
      action: 'PutObject',
      bucket: 'hornbook-audio',
      object: { key: '2026-05-01-topic.mp4' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnvWithBucket() as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('drops (ack, no fetch) an event from a different bucket', async () => {
    const msg = makeMessage({
      action: 'PutObject',
      bucket: 'some-other-bucket',
      object: { key: '2026-05-01-topic.mp4' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnvWithBucket() as any);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('drops (ack, no fetch) an event with no bucket field when R2_BUCKET is set', async () => {
    const msg = makeMessage({ action: 'PutObject', object: { key: '2026-05-01-topic.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnvWithBucket() as any);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('skips the bucket check when R2_BUCKET is not configured', async () => {
    const msg = makeMessage({
      action: 'PutObject',
      bucket: 'whatever',
      object: { key: '2026-05-01-topic.mp4' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('queue handler — key shapes and request options', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a path-prefixed key and passes it through verbatim', async () => {
    const msg = makeMessage({ action: 'PutObject', object: { key: 'uploads/2026-05-01-topic.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      event_type: 'process-lesson',
      client_payload: { r2_key: 'uploads/2026-05-01-topic.mp4' },
    });
  });

  it('accepts an upper-case extension (CI matches case-insensitively too)', async () => {
    const msg = makeMessage({ action: 'PutObject', object: { key: 'Lezione.MP4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('sends the GitHub request with an abort signal (timeout)', async () => {
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DISPATCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('does not ack before the dispatch has resolved', async () => {
    const order: string[] = [];
    fetchSpy.mockImplementationOnce(async () => {
      order.push('fetch');
      return mockFetchResponse(200);
    });
    const msg = makeMessage({ action: 'PutObject', object: { key: 'a.mp4' } });
    msg.ack.mockImplementation(() => order.push('ack'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, makeEnv() as any);
    expect(order).toEqual(['fetch', 'ack']);
  });
});

describe('queue handler — failure isolation within a batch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a rejected fetch for one message does not stop later messages', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValue(mockFetchResponse(200));
    const first = makeMessage({ action: 'PutObject', object: { key: 'first.mp4' } });
    const second = makeMessage({ action: 'PutObject', object: { key: 'second.mp4' } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([first, second]) as any, makeEnv() as any);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(second.retry).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Idempotency
// -----------------------------------------------------------------------------

function makeR2Event(overrides: Record<string, unknown> = {}) {
  return {
    account: 'acct',
    action: 'PutObject',
    bucket: 'hornbook-audio',
    object: { key: '2026-05-01-topic.mp4', size: 123, eTag: 'etag-v1' },
    eventTime: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('uploadIdentity', () => {
  it('is stable for the same event', async () => {
    const a = await uploadIdentity(makeR2Event());
    const b = await uploadIdentity(makeR2Event());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the object version (eTag) changes', async () => {
    const v1 = await uploadIdentity(makeR2Event());
    const v2 = await uploadIdentity(makeR2Event({ object: { key: '2026-05-01-topic.mp4', eTag: 'etag-v2' } }));
    expect(v1).not.toBe(v2);
  });

  it('changes with the bucket and the key', async () => {
    const base = await uploadIdentity(makeR2Event());
    expect(await uploadIdentity(makeR2Event({ bucket: 'other-bucket' }))).not.toBe(base);
    expect(
      await uploadIdentity(makeR2Event({ object: { key: '2026-05-02-other.mp4', eTag: 'etag-v1' } })),
    ).not.toBe(base);
  });

  it('falls back to eventTime when eTag is absent (redeliveries still dedup)', async () => {
    const event = makeR2Event({ object: { key: 'a.mp4' } });
    const a = await uploadIdentity(event);
    const b = await uploadIdentity(makeR2Event({ object: { key: 'a.mp4' } }));
    expect(a).toBe(b);
    const later = await uploadIdentity(
      makeR2Event({ object: { key: 'a.mp4' }, eventTime: '2026-05-01T11:00:00.000Z' }),
    );
    expect(later).not.toBe(a);
  });
});

describe('UploadDedup — claim semantics', () => {
  function makeStub() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = new UploadDedup({ storage: new FakeStorage() } as any);
    return {
      claim: async () => {
        const resp = await obj.fetch(new Request('https://dedup/claim', { method: 'POST' }));
        return (await resp.json()) as { result: string };
      },
      complete: async (outcome: string) => {
        await obj.fetch(
          new Request('https://dedup/complete', { method: 'POST', body: JSON.stringify({ outcome }) }),
        );
      },
      status: async () => {
        const resp = await obj.fetch(new Request('https://dedup/status'));
        return { status: resp.status, body: await resp.json() };
      },
    };
  }

  it('first claim wins, immediate second claim is in-progress', async () => {
    const stub = makeStub();
    expect((await stub.claim()).result).toBe('claimed');
    expect((await stub.claim()).result).toBe('in-progress');
  });

  it('after complete(dispatched), further claims are duplicates', async () => {
    const stub = makeStub();
    await stub.claim();
    await stub.complete('dispatched');
    expect((await stub.claim()).result).toBe('duplicate');
  });

  it('after complete(failed), the identity can be claimed again', async () => {
    const stub = makeStub();
    await stub.claim();
    await stub.complete('failed');
    expect((await stub.claim()).result).toBe('claimed');
  });

  it('an expired processing lease can be reclaimed', async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStub();
      expect((await stub.claim()).result).toBe('claimed');
      vi.advanceTimersByTime(CLAIM_LEASE_MS + 1);
      expect((await stub.claim()).result).toBe('claimed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a bad complete outcome and reports status', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = new UploadDedup({ storage: new FakeStorage() } as any);
    const bad = await obj.fetch(
      new Request('https://dedup/complete', { method: 'POST', body: JSON.stringify({ outcome: 'nope' }) }),
    );
    expect(bad.status).toBe(400);

    const unknown = await obj.fetch(new Request('https://dedup/status'));
    expect(unknown.status).toBe(404);

    await obj.fetch(
      new Request('https://dedup/complete', { method: 'POST', body: JSON.stringify({ outcome: 'dispatched' }) }),
    );
    const known = await obj.fetch(new Request('https://dedup/status'));
    expect(known.status).toBe(200);
    expect(await known.json()).toMatchObject({ state: 'dispatched' });
  });
});

describe('queue handler — dedup', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sequential duplicates: identical events dispatch only once', async () => {
    const env = makeEnv();
    const first = makeMessage(makeR2Event());
    const second = makeMessage(makeR2Event());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([first]) as any, env as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([second]) as any, env as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(second.retry).not.toHaveBeenCalled();
  });

  it('same key with a new eTag is a new upload and dispatches again', async () => {
    const env = makeEnv();
    const v1 = makeMessage(makeR2Event());
    const v2 = makeMessage(makeR2Event({ object: { key: '2026-05-01-topic.mp4', eTag: 'etag-v2' } }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([v1]) as any, env as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([v2]) as any, env as any);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(v1.ack).toHaveBeenCalledTimes(1);
    expect(v2.ack).toHaveBeenCalledTimes(1);
  });

  it('concurrent duplicates cannot race into duplicate dispatches', async () => {
    let resolveFetch!: (resp: Response) => void;
    fetchSpy.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const env = makeEnv();
    const winner = makeMessage(makeR2Event());
    const racer = makeMessage(makeR2Event());

    // The winner claims the identity and blocks inside the GitHub dispatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const winnerDone = dispatcher.queue(makeBatch([winner]) as any, env as any);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // A racing delivery of the same identity sees 'in-progress': ack, no fetch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([racer]) as any, env as any);
    expect(racer.ack).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch(mockFetchResponse(200));
    await winnerDone;
    expect(winner.ack).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retryable failure marks the identity failed and a redelivery can claim it again', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(500, 'oops'))
      .mockResolvedValueOnce(mockFetchResponse(200));
    const env = makeEnv();
    const attempt1 = makeMessage(makeR2Event());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([attempt1]) as any, env as any);
    expect(attempt1.retry).toHaveBeenCalledTimes(1);
    expect(attempt1.ack).not.toHaveBeenCalled();

    // The queue redelivers the same message; the 'failed' state lets it reclaim.
    const attempt2 = makeMessage(makeR2Event());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([attempt2]) as any, env as any);
    expect(attempt2.ack).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('fetch handler — operator endpoints', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const TOKEN = 'replay-secret';

  const authed = (url: string, init: RequestInit = {}) =>
    new Request(url, { ...init, headers: { Authorization: `Bearer ${TOKEN}` } });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(200));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 404 for everything when REPLAY_TOKEN is not configured', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await dispatcher.fetch(authed('https://op/status', { method: 'POST' }), makeEnv() as any);
    expect(resp.status).toBe(404);
  });

  it('rejects requests without the bearer token', async () => {
    const env = makeEnv({ REPLAY_TOKEN: TOKEN });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noAuth = await dispatcher.fetch(new Request('https://op/replay', { method: 'POST' }), env as any);
    expect(noAuth.status).toBe(401);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrongAuth = await dispatcher.fetch(
      new Request('https://op/replay', { method: 'POST', headers: { Authorization: 'Bearer nope' } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    expect(wrongAuth.status).toBe(401);
  });

  it('rejects a malformed replay body with 400', async () => {
    const env = makeEnv({ REPLAY_TOKEN: TOKEN });
    const resp = await dispatcher.fetch(
      authed('https://op/replay', { method: 'POST', body: 'not json' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    expect(resp.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('replays a dead-lettered event through the normal path and dispatches', async () => {
    const env = makeEnv({ REPLAY_TOKEN: TOKEN });
    const resp = await dispatcher.fetch(
      authed('https://op/replay', { method: 'POST', body: JSON.stringify(makeR2Event()) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ result: 'dispatched' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('replaying an already-dispatched event is a safe no-op', async () => {
    const env = makeEnv({ REPLAY_TOKEN: TOKEN });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([makeMessage(makeR2Event())]) as any, env as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const resp = await dispatcher.fetch(
      authed('https://op/replay', { method: 'POST', body: JSON.stringify(makeR2Event()) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ result: 'duplicate' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('replays an event whose earlier dispatch failed (DLQ flow)', async () => {
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(403, 'forbidden'))
      .mockResolvedValueOnce(mockFetchResponse(200));
    const env = makeEnv({ REPLAY_TOKEN: TOKEN });

    // Live delivery fails with a retryable auth error and would land in the DLQ.
    const msg = makeMessage(makeR2Event());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([msg]) as any, env as any);
    expect(msg.retry).toHaveBeenCalledTimes(1);

    // Operator fixes the token and replays the DLQ message body.
    const resp = await dispatcher.fetch(
      authed('https://op/replay', { method: 'POST', body: JSON.stringify(makeR2Event()) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ result: 'dispatched' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('reports a failed replay with a non-200 status', async () => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, 'oops'));
    const env = makeEnv({ REPLAY_TOKEN: TOKEN });
    const resp = await dispatcher.fetch(
      authed('https://op/replay', { method: 'POST', body: JSON.stringify(makeR2Event()) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    expect(resp.status).toBe(502);
    expect(await resp.json()).toEqual({ result: 'retry' });
  });

  it('/status returns the identity and the dedup record without dispatching', async () => {
    const env = makeEnv({ REPLAY_TOKEN: TOKEN });

    const before = await dispatcher.fetch(
      authed('https://op/status', { method: 'POST', body: JSON.stringify(makeR2Event()) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    const beforeBody = (await before.json()) as { identity: string; record: unknown };
    expect(before.status).toBe(200);
    expect(beforeBody.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(beforeBody.record).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatcher.queue(makeBatch([makeMessage(makeR2Event())]) as any, env as any);

    const after = await dispatcher.fetch(
      authed('https://op/status', { method: 'POST', body: JSON.stringify(makeR2Event()) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    const afterBody = (await after.json()) as { identity: string; record: { state: string } };
    expect(afterBody.identity).toBe(beforeBody.identity);
    expect(afterBody.record).toMatchObject({ state: 'dispatched' });
  });
});
