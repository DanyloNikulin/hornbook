import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { ProcessSupervisor, posixTerminationTargets } from './process-supervisor.ts';
import { retryableShutdown } from './shutdown.ts';

it.each([false, true])('can retry the entire shutdown chain after termination fails (closed=%s)', async (closeOnFailure) => {
  const child = new EventEmitter() as ChildProcess;
  const error = new Error('transient termination failure');
  const failed = vi.fn();
  const terminate = vi.fn().mockImplementationOnce(async () => {
    if (closeOnFailure) child.emit('close', 0);
    throw error;
  }).mockImplementationOnce(async () => { child.emit('close', 0); });
  const supervisor = new ProcessSupervisor(child, { ownsProcessGroup: false, terminate, onTerminationError: failed });
  let finished = false; void supervisor.completion.then(() => { finished = true; });
  const work = retryableShutdown(async () => { await supervisor.stop('shutdown'); });
  const server = retryableShutdown(work); const desktop = retryableShutdown(server);
  const first = desktop(); expect(desktop()).toBe(first);
  await expect(first).rejects.toBe(error);
  expect(failed).toHaveBeenCalledWith(error); expect(finished).toBe(false);
  await desktop(); expect(finished).toBe(true);
  expect(terminate).toHaveBeenCalledTimes(2);
  await desktop(); expect(terminate).toHaveBeenCalledTimes(2);
});

it('does not signal a process group unless its ownership was explicitly declared', () => {
  const rows = [[10, 1], [20, 10], [30, 20], [40, 1]];
  expect(posixTerminationTargets(10, rows, false)).toEqual([30, 20, 10]);
  expect(posixTerminationTargets(10, rows, true)).toEqual([30, 20, -10, 10]);
});

it('does not terminate again when the child exited before shutdown began', async () => {
  const child = new EventEmitter() as ChildProcess; const terminate = vi.fn();
  const supervisor = new ProcessSupervisor(child, { ownsProcessGroup: false, terminate });
  child.emit('close', 0); await supervisor.stop('shutdown');
  expect(terminate).not.toHaveBeenCalled();
});
