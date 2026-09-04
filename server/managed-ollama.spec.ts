import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ManagedOllama, activeManagedHost } from './managed-ollama.ts';

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.exitCode = null;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn(() => {
    c.exitCode = 0;
    c.emit('exit', 0);
    return true;
  });
  return c;
}

const ok = () => new Response('{"version":"0.33.3"}', { status: 200 });

describe('ManagedOllama', () => {
  it('does nothing without the binary', async () => {
    const spawn = vi.fn();
    const m = new ManagedOllama({ exe: 'C:/t/ollama/ollama.exe', modelsDir: 'C:/t/models', port: 11435, exists: () => false, spawn: spawn as never });
    expect(m.available()).toBe(false);
    expect(await m.start()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns "ollama serve" on its own port and models folder, then reports up', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://127.0.0.1:11435/api/version');
      return ok();
    }) as unknown as typeof fetch;
    const m = new ManagedOllama({
      exe: 'C:/t/ollama/ollama.exe',
      modelsDir: 'C:/t/models',
      port: 11435,
      exists: () => true,
      spawn: spawn as never,
      fetch: fetchImpl,
      env: { PATH: 'x' },
    });
    expect(await m.start()).toBe(true);
    expect(m.running()).toBe(true);
    expect(activeManagedHost()).toBe('http://127.0.0.1:11435');
    const [exe, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(exe).toBe('C:/t/ollama/ollama.exe');
    expect(args).toEqual(['serve']);
    expect(opts.env).toMatchObject({ PATH: 'x', OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: 'C:/t/models' });

    // A second start while running does not spawn again.
    expect(await m.start()).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);

    m.stop();
    expect(child.kill).toHaveBeenCalled();
    expect(m.running()).toBe(false);
    expect(activeManagedHost()).toBeUndefined();
  });

  it('gives up and kills a server that never answers', async () => {
    const child = fakeChild();
    const lines: string[] = [];
    const m = new ManagedOllama({
      exe: 'C:/t/ollama/ollama.exe',
      modelsDir: 'C:/t/models',
      port: 11436,
      exists: () => true,
      spawn: vi.fn(() => child as unknown as ChildProcess) as never,
      fetch: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      startupMs: 250,
      log: (l) => lines.push(l),
    });
    expect(await m.start()).toBe(false);
    expect(child.kill).toHaveBeenCalled();
    expect(m.running()).toBe(false);
    expect(lines.join('\n')).toMatch(/did not answer/);
  });

  it('forgets the process when it exits on its own', async () => {
    const child = fakeChild();
    const m = new ManagedOllama({
      exe: 'C:/t/ollama/ollama.exe',
      modelsDir: 'C:/t/models',
      port: 11437,
      exists: () => true,
      spawn: vi.fn(() => child as unknown as ChildProcess) as never,
      fetch: vi.fn(async () => ok()) as unknown as typeof fetch,
    });
    expect(await m.start()).toBe(true);
    child.exitCode = 1;
    child.emit('exit', 1);
    expect(m.running()).toBe(false);
    expect(activeManagedHost()).toBeUndefined();
  });
});
