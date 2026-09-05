import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobRunner } from './jobs.ts';

it('retains a failed CLI parent until Jobs can retry termination of its real descendant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hornbook-cli-cleanup-tree-'));
  const heartbeat = join(root, 'heartbeat');
  const worker = join(root, 'worker.mjs');
  const supervisor = pathToFileURL(resolve('scripts/lib/process-supervisor.ts')).href;
  const failure = pathToFileURL(resolve('scripts/lib/cli-failure.ts')).href;
  const leaf = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(heartbeat)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),30);`;
  writeFileSync(worker, `
    import {spawn} from 'node:child_process';
    import {existsSync} from 'node:fs';
    import {ProcessSupervisor,ProcessCleanupError} from ${JSON.stringify(supervisor)};
    import {retainFailedCleanup} from ${JSON.stringify(failure)};
    const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true,windowsHide:true});
    while(!existsSync(${JSON.stringify(heartbeat)})) await new Promise(r=>setTimeout(r,10));
    const owner=new ProcessSupervisor(child,{ownsProcessGroup:true,timeoutMs:5,terminate:async()=>{throw new Error('injected CLI termination denial');}});
    const result=await owner.result;
    retainFailedCleanup(new ProcessCleanupError(result.error,owner));
  `);
  const jobs = new JobRunner({ repoRoot: root, cwd: resolve('.'), journalDir: () => root, env: () => process.env, timeoutMs: 10_000,
    runner: () => ({ cmd: process.execPath, args: ['--import', 'tsx', worker, '--'] }) });
  try {
    const job = jobs.enqueue('es-en', { kind: 'process', filename: 'fixture.json', date: '2099-01-01', base64: 'e30=' });
    const deadline = Date.now() + 5000;
    while (jobs.get(job.id)?.status !== 'failed' && Date.now() < deadline) await new Promise((r) => setTimeout(r,20));
    expect(jobs.get(job.id), jobs.get(job.id)?.log).toMatchObject({ status: 'failed', cleanup: { status: 'failed', error: expect.stringContaining('injected CLI termination denial') } });
    expect(jobs.activeCount()).toBe(1);
    const pid = Number(readFileSync(heartbeat, 'utf8').split('.')[0]);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(readdirSync(join(root, '_uploads'))).toHaveLength(1);
    await jobs.retryCleanup(job.id);
    await jobs.idle();
    // The OS may reap a terminated descendant after the parent exits.
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        return false;
      }
    }, { timeout: 5000 }).toBe(false);
    expect(jobs.get(job.id)?.cleanup).toBeUndefined();
    expect(readdirSync(join(root, '_uploads'))).toHaveLength(0);
  } finally { await jobs.stop(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
