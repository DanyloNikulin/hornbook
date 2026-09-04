import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobRunner } from './jobs.ts';

let dir: string;

// Scripts are replaced by tiny inline Node programs so the runner is tested
// without ffmpeg, models or keys. `runner` maps a script name to a command.
function makeRunner(programs: Record<string, string>): JobRunner {
  return new JobRunner({
    repoRoot: dir,
    journalDir: () => dir,
    env: () => ({ ...process.env, HORNBOOK_TEST_ENV: 'yes' }),
    // `--` keeps Node from reading the job flags (--section …) as its own options.
    runner: (script) => ({ cmd: process.execPath, args: ['-e', programs[script] ?? 'process.exit(3)', '--'] }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hornbook-jobs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('JobRunner', () => {
  it('runs a process job, captures the log, parses the result and deletes the upload', async () => {
    const runner = makeRunner({
      'process.ts':
        'const a=process.argv.slice(1);console.log("args:"+a.join(" "));console.log("env:"+process.env.HORNBOOK_TEST_ENV);console.log("HORNBOOK_RESULT "+JSON.stringify({slug:"greetings",id:"2026-01-01-greetings"}))',
    });
    const job = runner.enqueue('es-en', {
      kind: 'process',
      filename: 'lesson.txt',
      base64: Buffer.from('hello').toString('base64'),
      date: '2026-01-01',
      from: 'transcript',
    });
    expect(['queued', 'running']).toContain(job.status);
    expect(job.label).toBe('lesson.txt');
    expect(readdirSync(join(dir, '_uploads'))).toHaveLength(1);

    await runner.idle();
    const done = runner.get(job.id)!;
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ slug: 'greetings', id: '2026-01-01-greetings' });
    expect(done.log).toContain('--date 2026-01-01');
    expect(done.log).toContain('--from transcript');
    expect(done.log).toContain('--section es-en');
    expect(done.log).toContain('env:yes');
    expect(readdirSync(join(dir, '_uploads'))).toHaveLength(0);
  });

  it('follows a setup job: progress lines, result and the finish hook', async () => {
    const finished: string[] = [];
    const runner = new JobRunner({
      repoRoot: dir,
      journalDir: () => dir,
      env: () => process.env,
      onFinish: (job) => finished.push(`${job.kind}:${job.status}`),
      runner: () => ({
        cmd: process.execPath,
        args: [
          '-e',
          'const a=process.argv.slice(1);console.log("args:"+a.join(" "));console.log("HORNBOOK_PROGRESS "+JSON.stringify({pct:10,bytes:1,total:10,stage:"downloading"}));console.log("HORNBOOK_PROGRESS "+JSON.stringify({pct:100,stage:"done"}));console.log("HORNBOOK_RESULT "+JSON.stringify({tool:"whisper",path:"C:/t/whisper/whisper-cli.exe",version:"b4938"}))',
          '--',
        ],
      }),
    });
    const job = runner.enqueue('_setup', { kind: 'setup', tool: 'whisper', variant: 'cuda', sha256: 'ab'.repeat(32) });
    expect(job.label).toBe('Set up whisper');
    await runner.idle();
    const done = runner.get(job.id)!;
    expect(done.status).toBe('done');
    expect(done.log).toContain('--tool whisper --variant cuda --expect-sha256 ' + 'ab'.repeat(32));
    expect(done.progress).toEqual({ pct: 100, stage: 'done' });
    expect(done.result).toEqual({ tool: 'whisper', path: 'C:/t/whisper/whisper-cli.exe', version: 'b4938' });
    expect(finished).toEqual(['setup:done']);
    expect(runner.list('_setup').map((j) => j.id)).toEqual([job.id]);
  });
  it('stop() kills the running job and drops the queue', async () => {
    const runner = makeRunner({
      'build-cheatsheet.ts': 'setTimeout(() => console.log("late"), 30000)',
      'review-vocab.ts': 'console.log("never")',
    });
    const first = runner.enqueue('es-en', { kind: 'cheatsheet' });
    const second = runner.enqueue('es-en', { kind: 'review-topics' });
    await new Promise((r) => setTimeout(r, 300));
    runner.stop();
    await runner.idle();
    // The killed child releases its working directory a moment later on Windows.
    await new Promise((r) => setTimeout(r, 700));
    expect(runner.get(first.id)?.status).toBe('failed');
    expect(runner.get(first.id)?.error).toMatch(/stopped with the server/);
    expect(runner.get(second.id)?.status).toBe('queued');
  });

  it('marks a failing job failed with the last error line and keeps going', async () => {
    const runner = makeRunner({
      'build-cheatsheet.ts': 'console.error("✘ ANTHROPIC_API_KEY env var is required");process.exit(1)',
      'review-vocab.ts': 'console.log("ok")',
    });
    const a = runner.enqueue('es-en', { kind: 'cheatsheet', force: true });
    const b = runner.enqueue('es-en', { kind: 'review-topics' });
    await runner.idle();
    expect(runner.get(a.id)?.status).toBe('failed');
    expect(runner.get(a.id)?.error).toContain('ANTHROPIC_API_KEY');
    expect(runner.get(a.id)?.log).toContain('--force');
    expect(runner.get(b.id)?.status).toBe('done');
    expect(runner.list('es-en').map((j) => j.id)).toEqual([b.id, a.id]);
    expect(runner.list('it-en')).toEqual([]);
  });

  it('runs jobs one at a time in order', async () => {
    const runner = makeRunner({
      'review-vocab.ts': 'setTimeout(()=>{console.log("done "+Date.now())},60)',
    });
    const a = runner.enqueue('es-en', { kind: 'review-topics' });
    const b = runner.enqueue('es-en', { kind: 'review-topics' });
    expect(runner.get(a.id)?.status).toBe('running');
    expect(runner.get(b.id)?.status).toBe('queued');
    await runner.idle();
    const ta = Number(runner.get(a.id)!.log.match(/done (\d+)/)![1]);
    const tb = Number(runner.get(b.id)!.log.match(/done (\d+)/)![1]);
    expect(tb).toBeGreaterThanOrEqual(ta);
  });

  it('does not expose the command internals in views', async () => {
    const runner = makeRunner({ 'review-vocab.ts': 'console.log(1)' });
    const job = runner.enqueue('es-en', { kind: 'review-topics' });
    expect((job as unknown as Record<string, unknown>)['cmd']).toBeUndefined();
    await runner.idle();
    expect(existsSync(join(dir, '_uploads'))).toBe(false);
  });
});
