import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { startServer } from './main.ts';
import { FolderStore } from './store.ts';
import { JobRunner } from './jobs.ts';
import type { JobView } from '../src/lib/api-types.ts';

it('server shutdown waits for active descendants and queued upload cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hornbook-shutdown-'));
  const journal = join(root, 'journal'); const scripts = join(root, 'scripts');
  mkdirSync(scripts); vi.stubEnv('HORNBOOK_TOOLS', join(root, 'tools'));
  const store = new FolderStore(journal); store.createSection({ target: 'es', learner: 'en' });
  const heartbeat = join(root, 'heartbeat');
  const leaf = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},String(process.pid));console.log('READY');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20)`;
  writeFileSync(join(scripts, 'process.js'), `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000);`);
  const finished: JobView[] = [];
  const server = startServer({ port: 0, host: '127.0.0.1', journal, dist: root, serveStatic: false, password: undefined, scriptDir: scripts, onJobFinish: (job) => finished.push(job) });
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const submit = () => fetch(base + '/api/sections/es-en/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'process', filename: 'fixture.txt', base64: 'aGk=', date: '2026-09-05' }) }).then((response) => response.json()) as Promise<JobView>;
    const first = await submit(); const second = await submit();
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (await fetch(base + `/api/jobs/${first.id}`)).json() as JobView;
      if (state.log.includes('\nREADY\n')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = server.shutdown(); expect(server.shutdown()).toBe(pending); await pending;
    expect(finished.map((job) => job.id).sort()).toEqual([first.id, second.id].sort());
    expect(finished.every((job) => job.status === 'failed')).toBe(true);
    expect(readdirSync(join(journal, '_uploads'))).toHaveLength(0);
    expect(() => process.kill(Number(readFileSync(heartbeat, 'utf8').split('.')[0]), 0)).toThrow();
  } finally {
    await server.shutdown(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 15_000);

it('retries rejected server cleanup and removes signal handlers after success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hornbook-shutdown-retry-'));
  vi.stubEnv('HORNBOOK_TOOLS', join(root, 'tools'));
  const count = process.listenerCount('SIGINT');
  const server = startServer({ port: 0, host: '127.0.0.1', journal: join(root, 'journal'), dist: root, serveStatic: false, password: undefined });
  const stop = vi.spyOn(JobRunner.prototype, 'stop').mockRejectedValueOnce(new Error('transient cleanup failure'));
  try {
    await once(server, 'listening');
    await expect(server.shutdown()).rejects.toThrow('transient cleanup failure');
    await server.shutdown();
    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(process.listenerCount('SIGINT')).toBe(count);
  } finally {
    await server.shutdown(); stop.mockRestore(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
