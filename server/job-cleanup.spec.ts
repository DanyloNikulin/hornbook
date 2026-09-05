import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRunner } from './jobs.ts';

const fault = vi.hoisted(() => ({ upload: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, rmSync: (...args: Parameters<typeof fs.rmSync>) => {
    if (fault.upload && String(args[0]).includes('_uploads')) throw new Error('upload denied');
    return fs.rmSync(...args);
  } };
});
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hornbook-job-cleanup-')); });
afterEach(() => { fault.upload = false; rmSync(root, { recursive: true, force: true }); });
const input = { kind: 'process' as const, filename: 'fixture.json', date: '2099-01-01', base64: 'e30=' };
function child(): ChildProcess {
  const value = new EventEmitter() as ChildProcess;
  value.stdout = new PassThrough(); value.stderr = new PassThrough();
  return value;
}
function runner(process: ChildProcess, terminate?: (child: ChildProcess, ownsGroup: boolean) => Promise<void>): JobRunner {
  return new JobRunner({ repoRoot: root, journalDir: () => root, env: () => ({}),
    spawn: (() => process) as typeof spawn, runner: () => ({ cmd: 'synthetic', args: [] }), timeoutMs: 10, terminate });
}

it('keeps successful work successful and retries a failed upload cleanup', async () => {
  const process = child(); const jobs = runner(process);
  const job = jobs.enqueue('es-en', input);
  fault.upload = true;
  process.emit('message', { type: 'result', result: { slug: 'saved' } });
  process.emit('close', 0);
  await jobs.idle();
  expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: { slug: 'saved' }, cleanup: { status: 'failed', error: expect.stringContaining('upload denied') } });
  expect(readdirSync(join(root, '_uploads'))).toHaveLength(1);
  fault.upload = false;
  await jobs.retryCleanup(job.id);
  expect(jobs.get(job.id)?.cleanup).toBeUndefined();
  expect(readdirSync(join(root, '_uploads'))).toHaveLength(0);
});

it.each([false, true])('reports timeout cleanup failure and retries without reopening genuine shutdown (%s)', async (shutdown) => {
  const process = child();
  const terminate = vi.fn().mockRejectedValueOnce(new Error('termination denied')).mockImplementationOnce(async () => { process.emit('close', 0); });
  const jobs = runner(process, terminate);
  const job = jobs.enqueue('es-en', input);
  await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe('failed'));
  expect(jobs.get(job.id)?.cleanup).toMatchObject({ status: 'failed' });
  expect(() => jobs.enqueue('es-en', input)).toThrow(/cleanup.*termination denied/i);
  expect(jobs.activeCount()).toBe(1);
  expect(readdirSync(join(root, '_uploads'))).toHaveLength(1);
  if (shutdown) await jobs.stop(); else await jobs.retryCleanup(job.id);
  await jobs.idle();
  expect(readdirSync(join(root, '_uploads'))).toHaveLength(0);
  expect(jobs.get(job.id)?.cleanup).toBeUndefined();
  if (shutdown) expect(() => jobs.enqueue('es-en', input)).toThrow('shutting down');
  else { expect(() => jobs.enqueue('es-en', input)).not.toThrow(); process.emit('close', 0); await jobs.idle(); }
});
