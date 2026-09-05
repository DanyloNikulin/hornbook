import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CliExtractor } from './cli-extract.ts';
import { ProcessCleanupError } from '../lib/process-supervisor.ts';

const mock = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn() }));
vi.mock('../lib/process.ts', () => ({ spawnProcess: mock.spawn }));
vi.mock('../lib/process-supervisor.ts', async (original) => {
  const actual = await original<typeof import('../lib/process-supervisor.ts')>();
  return { ...actual, ProcessSupervisor: class extends actual.ProcessSupervisor {
    constructor(child: ChildProcess, options: ConstructorParameters<typeof actual.ProcessSupervisor>[1]) {
      super(child, { ...options, terminate: mock.terminate });
    }
  } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['timeout', 'abort'] as const)('reports %s cleanup failure promptly and keeps scratch until cleanup is retried', async (mode) => {
  vi.stubEnv('CLAUDE_BIN', process.execPath);
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  mock.spawn.mockReturnValue(child);
  mock.terminate.mockRejectedValueOnce(new Error('termination denied')).mockImplementationOnce(async () => { child.emit('close', 0); });
  const cancel = new AbortController();
  const result = new CliExtractor('claude', '-').extract({ system: 'Synthetic test', userParts: [], jsonSchema: {}, toolName: 'test', timeoutMs: mode === 'timeout' ? 5 : 1000, signal: cancel.signal }).catch((error: unknown) => error);
  if (mode === 'abort') cancel.abort();
  const error = await result;
  expect(error).toBeInstanceOf(ProcessCleanupError);
  if (!(error instanceof ProcessCleanupError)) throw error;
  const dir = mock.spawn.mock.calls[0][2].cwd as string;
  expect(existsSync(dir)).toBe(true);
  await error.retryCleanup();
  await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
  expect(mock.terminate).toHaveBeenCalledTimes(2);
});
