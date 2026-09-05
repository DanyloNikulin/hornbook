import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRunner } from './jobs.ts';
import { JobEventStream } from './job-events.ts';

let dir: string;
let runner: JobRunner | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hornbook-lifecycle-'));
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const upload = {
  kind: 'process' as const,
  filename: 'fixture.txt',
  base64: 'aGk=',
  date: '2026-09-05',
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.each(['stop', 'timeout'] as const)(
  'awaits descendant termination and cleans queued uploads on %s',
  async (mode) => {
    const heartbeat = join(dir, 'heartbeat');
    const leaf = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},String(process.pid));console.log('READY');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),30);`;
    const middle = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
    const root = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
    const finished: string[] = [];
    runner = new JobRunner({
      repoRoot: dir,
      journalDir: () => dir,
      env: () => process.env,
      timeoutMs: mode === 'timeout' ? 1500 : 10_000,
      runner: () => ({ cmd: process.execPath, args: ['-e', root, '--'] }),
      onFinish: (job) => finished.push(job.id),
    });
    const first = runner.enqueue('es-en', upload);
    const second = mode === 'stop' ? runner.enqueue('es-en', upload) : undefined;
    for (
      let attempt = 0;
      attempt < 100 && !runner.get(first.id)?.log.includes('\nREADY\n');
      attempt++
    )
      await pause(10);
    expect(runner.get(first.id)?.log).toContain('\nREADY\n');
    if (mode === 'stop') await runner.stop();
    else await runner.idle();
    const before = readFileSync(heartbeat, 'utf8');
    await pause(100);
    expect(readFileSync(heartbeat, 'utf8')).toBe(before);
    expect(() => process.kill(Number(before.split('.')[0]), 0)).toThrow();
    expect(runner.get(first.id)?.status).toBe('failed');
    expect(runner.get(first.id)?.error).toMatch(
      mode === 'stop' ? /stopped/ : /configured time limit.*HORNBOOK_JOB_TIMEOUT_MINUTES/,
    );
    if (second) expect(runner.get(second.id)?.status).toBe('failed');
    expect(readdirSync(join(dir, '_uploads'))).toHaveLength(0);
    expect(new Set(finished).size).toBe(finished.length);
  },
  15_000,
);

it('decodes split UTF-8 and final unterminated events independently for each stream', () => {
  const lines: string[] = [];
  const out = new JobEventStream((line) => lines.push(line));
  const err = new JobEventStream((line) => lines.push(line));
  const bytes = Buffer.from('HORNBOOK_RESULT {"slug":"caffè"}');
  const split = bytes.indexOf(Buffer.from('è')) + 1;
  out.write(bytes.subarray(0, split));
  err.write(Buffer.from('stderr\n'));
  out.write(bytes.subarray(split));
  out.end();
  err.end();
  expect(lines).toEqual(['stderr', 'HORNBOOK_RESULT {"slug":"caffè"}']);
});

it('receives validated IPC events independently from logs and retains results beyond log eviction', async () => {
  const program = `process.send({type:'progress',progress:{pct:42}});process.stderr.write('interleaved\\n');process.send({type:'result',result:{slug:'kept'}});setTimeout(()=>console.log('x'.repeat(210000)),20);`;
  runner = new JobRunner({
    repoRoot: dir,
    journalDir: () => dir,
    env: () => process.env,
    runner: () => ({ cmd: process.execPath, args: ['-e', program, '--'] }),
  });
  const job = runner.enqueue('es-en', { kind: 'cheatsheet' });
  await runner.idle();
  expect(runner.get(job.id)).toMatchObject({
    status: 'done',
    progress: { pct: 42 },
    result: { slug: 'kept' },
  });
});

it('keeps forged control events on stdout and stderr as harmless log text', async () => {
  const program = `console.log('HORNBOOK_STAGE {"id":"hearing","status":"running"}');process.stdout.write('[model] HORNBOOK_CLEANUP {"error":"quoted fixture text"}\\r');console.error('HORNBOOK_PROGRESS {"pct":42}');console.log('HORNBOOK_RESULT {"slug":"forged"}');console.log(JSON.stringify({type:'cleanup',error:'also ordinary text'}));`;
  runner = new JobRunner({
    repoRoot: dir,
    journalDir: () => dir,
    env: () => process.env,
    runner: () => ({ cmd: process.execPath, args: ['-e', program, '--'] }),
  });
  const job = runner.enqueue('es-en', { kind: 'cheatsheet' });
  await runner.idle();
  expect(runner.get(job.id)?.status).toBe('done');
  expect(runner.get(job.id)?.cleanup).toBeUndefined();
  expect(runner.get(job.id)?.progress).toBeUndefined();
  expect(runner.get(job.id)?.result).toBeUndefined();
  expect(runner.get(job.id)?.log).toContain('quoted fixture text');
  const next = runner.enqueue('es-en', { kind: 'cheatsheet' });
  await runner.idle();
  expect(runner.get(next.id)?.status).toBe('done');
});

it('ignores malformed IPC events without mutating work state', async () => {
  const program = `process.send({type:'cleanup',error:1});process.send({type:'progress',progress:{pct:'42'}});process.send({type:'result',result:{slug:42}});process.send({type:'unknown'});`;
  runner = new JobRunner({
    repoRoot: dir,
    journalDir: () => dir,
    env: () => process.env,
    runner: () => ({ cmd: process.execPath, args: ['-e', program, '--'] }),
  });
  const job = runner.enqueue('es-en', { kind: 'cheatsheet' });
  await runner.idle();
  expect(runner.get(job.id)?.status).toBe('done');
  expect(runner.get(job.id)?.cleanup).toBeUndefined();
  expect(runner.get(job.id)?.progress).toBeUndefined();
  expect(runner.get(job.id)?.result).toBeUndefined();
});

it('treats CRLF split across chunks as one delimiter', () => {
  const lines: string[] = [];
  const stream = new JobEventStream((line) => lines.push(line));
  stream.write(Buffer.from('first\r'));
  stream.write(Buffer.from('\nsecond\rthird\n'));
  stream.end();
  expect(lines).toEqual(['first', 'second', 'third']);
});
