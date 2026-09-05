// Pipeline jobs: one queue, one child process at a time, log kept in memory
// and streamed to the UI by polling. Jobs run the existing scripts
// (process, build-cheatsheet, review-vocab) with the journal's connection
// values in their environment, so local drivers (Ollama, whisper-cli) work
// exactly as they do from the command line.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ProcessSupervisor, type terminateProcessTree } from '../scripts/lib/process-supervisor.ts';
import { jobTimeout } from './job-timeout.ts';
import { JobEventStream } from './job-events.ts';
import { JobEvent, type JobEventT } from '../scripts/lib/job-protocol.ts';
import { randomBytes } from 'node:crypto';
import type {
  JobKind,
  JobStageStatus,
  JobStageView,
  JobView,
  ProcessStageId,
  StartJob,
  StartProcessJob,
  StartSetupJob,
} from '../src/lib/api-types.ts';

const MAX_LOG_CHARS = 200_000;
const MAX_JOBS_KEPT = 50;
const PROCESS_STAGES: readonly ProcessStageId[] = ['hearing', 'slides', 'writing', 'checking'];

export interface JobRunnerOptions {
  repoRoot: string;
  /** Real directory for child processes; packaged repoRoot may be app.asar. */
  cwd?: string;
  journalDir: () => string;
  env: () => NodeJS.ProcessEnv;
  /** Injectable for tests. */
  spawn?: typeof nodeSpawn;
  /** Command used to run a script; defaults to the current Node with tsx. */
  runner?: (script: string) => { cmd: string; args: string[] };
  /** Called once a job has ended, done or failed. */
  onFinish?: (job: JobView) => void;
  /** Called after queue/running state changes. */
  onChange?: (active: number) => void;
  timeoutMs?: number;
  terminate?: typeof terminateProcessTree;
}

interface Job extends JobView {
  cmd: string;
  args: string[];
  releaseUpload?: () => void;
  cleanupFlight?: Promise<JobView>;
}

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly order: string[] = [];
  private readonly queue: string[] = [];
  private running: { job: Job; process: ProcessSupervisor } | null = null;
  private admission: { phase: 'open' | 'shutdown' } | { phase: 'cleanup-blocked'; error: string } =
    { phase: 'open' };
  private readonly idleWaiters = new Set<() => void>();
  private readonly spawnFn: typeof nodeSpawn;
  private readonly runner: (script: string) => { cmd: string; args: string[] };

  constructor(private readonly opts: JobRunnerOptions) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.runner =
      opts.runner ??
      ((script) => ({
        cmd: process.execPath,
        args: ['--import', 'tsx', join(opts.repoRoot, 'scripts', script)],
      }));
  }

  /** Validate the request, stage any upload, and queue the job. */
  enqueue(section: string, input: StartJob): JobView {
    if (this.admission.phase === 'shutdown') throw new Error('Job runner is shutting down');
    if (this.admission.phase === 'cleanup-blocked') throw new Error(this.admission.error);
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    let label: string;
    let script: string;
    let extra: string[] = [];
    let cleanup: (() => void) | undefined;

    switch (input.kind) {
      case 'process': {
        const ext = extname(input.filename).toLowerCase() || '.bin';
        const uploads = join(this.opts.journalDir(), '_uploads');
        mkdirSync(uploads, { recursive: true });
        const file = join(uploads, `${id}${ext}`);
        writeFileSync(file, Buffer.from(input.base64, 'base64'));
        cleanup = () => rmSync(file, { force: true });
        label = input.filename;
        script = 'process.ts';
        extra = [
          file,
          '--date',
          input.date,
          ...(input.title ? ['--title', input.title] : []),
          ...(input.from ? ['--from', input.from] : []),
        ];
        break;
      }
      case 'setup':
        label = setupLabel(input);
        script = 'setup-tool.ts';
        extra = setupArgs(input);
        break;
      case 'cheatsheet':
        label = input.force ? 'Rebuild cheat sheet from scratch' : 'Update cheat sheet';
        script = 'build-cheatsheet.ts';
        extra = input.force ? ['--force'] : [];
        break;
      case 'review-topics':
        label = 'Review topics';
        script = 'review-vocab.ts';
        break;
    }

    let command: { cmd: string; args: string[] };
    try {
      command = this.runner(script);
    } catch (error) {
      cleanup?.();
      throw error;
    }
    const { cmd, args } = command;
    const createdAt = new Date().toISOString();
    const job: Job = {
      id,
      section,
      kind: input.kind as JobKind,
      status: 'queued',
      label,
      log: '',
      createdAt,
      ...(input.kind === 'process' ? { stages: initialProcessStages(input, createdAt) } : {}),
      cmd,
      args: [...args, ...extra, '--section', section],
      releaseUpload: cleanup,
    };
    this.jobs.set(id, job);
    this.order.push(id);
    this.queue.push(id);
    this.trim();
    this.pump();
    this.changed();
    return this.view(job);
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job ? this.view(job) : undefined;
  }

  list(section?: string): JobView[] {
    return this.order
      .map((id) => this.jobs.get(id))
      .filter((j): j is Job => !!j && (!section || j.section === section))
      .map((j) => this.view(j))
      .reverse();
  }

  activeCount(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** Reject new work, clean queued uploads, and await active tree termination. */
  async stop(): Promise<void> {
    this.admission = { phase: 'shutdown' };
    for (const id of this.queue.splice(0)) {
      const job = this.jobs.get(id);
      if (job) this.finish(job, 1, 'stopped with the server before starting');
    }
    if (this.running) await this.running.process.stop('stopped with the server');
    await this.idle();
    for (const job of this.jobs.values()) if (job.cleanup) await this.retryCleanup(job.id);
  }

  idle(): Promise<void> {
    if (this.activeCount() === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private view(job: Job): JobView {
    const { cmd: _cmd, args: _args, releaseUpload: _upload, cleanupFlight: _flight, ...view } = job;
    return view;
  }

  private trim(): void {
    while (this.order.length > MAX_JOBS_KEPT) {
      const id = this.order[0];
      const job = this.jobs.get(id);
      if (
        !job ||
        job.status === 'queued' ||
        job.status === 'running' ||
        job.cleanup ||
        this.running?.job === job
      )
        break;
      this.order.shift();
      this.jobs.delete(id);
    }
  }

  private pump(): void {
    if (this.running || this.admission.phase !== 'open') return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job) {
      this.pump();
      return;
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.log += `$ ${[job.cmd, ...job.args].map(shellish).join(' ')}\n\n`;

    let child: ChildProcess;
    try {
      child = this.spawnFn(job.cmd, job.args, {
        cwd: this.opts.cwd ?? this.opts.repoRoot,
        env: this.opts.env(),
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      this.finish(job, 1, (err as Error).message);
      return;
    }
    const timeoutMs = jobTimeout(job.kind, this.opts.timeoutMs);
    const supervised = new ProcessSupervisor(child, {
      ownsProcessGroup: process.platform !== 'win32',
      timeoutMs,
      terminate: this.opts.terminate,
      timeoutMessage: `Job reached its configured time limit (${timeoutMs / 60000} minutes). Set HORNBOOK_JOB_TIMEOUT_MINUTES to allow longer jobs.`,
      onTerminationError: (error) => this.blockForCleanup(job, error.message),
    });
    this.running = { job, process: supervised };
    child.on('message', (message: unknown) => {
      const event = JobEvent.safeParse(message);
      if (event.success) this.applyEvent(job, event.data);
    });
    const line = (text: string) => {
      job.log += text + '\n';
      if (job.log.length > MAX_LOG_CHARS) job.log = '…' + job.log.slice(-MAX_LOG_CHARS);
    };
    const stdout = new JobEventStream(line);
    const stderr = new JobEventStream(line);
    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));
    void supervised.result.then(({ code, error }) => {
      stdout.end();
      stderr.end();
      this.finish(job, code, error);
    });
    void supervised.completion.then(() => {
      if (this.running?.job === job) this.running = null;
      if (this.admission.phase === 'cleanup-blocked') this.admission = { phase: 'open' };
      this.cleanUpload(job);
      this.pump();
      this.changed();
    });
  }

  private finish(job: Job, code: number, error?: string): void {
    if (job.status === 'done' || job.status === 'failed') return;
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      job.status = 'done';
      for (const stage of job.stages ?? []) {
        if (stage.status === 'running') finishStage(stage, 'done', job.finishedAt);
        else if (stage.status === 'waiting') finishStage(stage, 'skipped', job.finishedAt);
      }
    } else {
      job.status = 'failed';
      const active = job.stages?.find((stage) => stage.status === 'running');
      if (active) finishStage(active, 'failed', job.finishedAt);
      job.error = error ?? lastErrorLine(job.log) ?? `exit code ${code}`;
      if (error) job.log += `\n${error}\n`;
    }
    if (this.running?.job === job) {
      if (!job.cleanup) job.cleanup = { status: 'pending' };
    } else this.cleanUpload(job);
    this.opts.onFinish?.(this.view(job));
    this.pump();
    this.changed();
  }

  private blockForCleanup(job: Job, detail: string): void {
    const error = `Process cleanup failed: ${detail}`;
    job.cleanup = { status: 'failed', error };
    if (this.admission.phase !== 'shutdown') this.admission = { phase: 'cleanup-blocked', error };
    this.finish(job, 1, error);
    this.changed();
  }

  async retryCleanup(id: string): Promise<JobView> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No job "${id}"`);
    if (job.cleanupFlight) return job.cleanupFlight;
    if (!job.cleanup) return this.view(job);
    job.cleanup = { status: 'pending' };
    job.cleanupFlight = (async () => {
      try {
        if (this.running?.job === job) await this.running.process.stop('retry process cleanup');
        this.cleanUpload(job);
        if (job.cleanup?.status === 'failed') throw new Error(job.cleanup.error);
        return this.view(job);
      } finally {
        this.changed();
      }
    })().finally(() => {
      job.cleanupFlight = undefined;
    });
    return job.cleanupFlight;
  }

  private cleanUpload(job: Job): void {
    if (this.running?.job === job) return;
    try {
      job.releaseUpload?.();
      job.releaseUpload = undefined;
      job.cleanup = undefined;
    } catch (error) {
      const message = `Upload cleanup failed: ${(error as Error).message}`;
      job.cleanup = { status: 'failed', error: message };
      job.log += '\n' + message + '\n';
    }
  }

  private changed(): void {
    this.opts.onChange?.(this.activeCount());
    if (this.activeCount() === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private applyEvent(job: Job, event: JobEventT): void {
    switch (event.type) {
      case 'cleanup':
        this.blockForCleanup(job, event.error);
        return;
      case 'progress':
        job.progress = event.progress;
        return;
      case 'result':
        job.result = event.result;
        return;
      case 'stage':
        break;
    }
    const stage = job.stages?.find((candidate) => candidate.id === event.id);
    if (!stage) return;
    const at = new Date().toISOString();
    if (event.status === 'running') {
      stage.status = 'running';
      stage.startedAt ??= at;
      delete stage.finishedAt;
    } else {
      stage.startedAt ??= at;
      finishStage(stage, event.status, at);
    }
  }
}

function initialProcessStages(input: StartProcessJob, createdAt: string): JobStageView[] {
  const from = input.from ?? inferProcessSource(input.filename);
  return PROCESS_STAGES.map((id) => {
    const skipped =
      (id === 'hearing' && (from === 'transcript' || from === 'json')) ||
      (id === 'slides' && from !== 'video') ||
      (id === 'writing' && from === 'json');
    return skipped
      ? { id, status: 'skipped', startedAt: createdAt, finishedAt: createdAt }
      : { id, status: 'waiting' };
  });
}

function inferProcessSource(filename: string): NonNullable<StartProcessJob['from']> {
  const ext = extname(filename).toLowerCase();
  if (['.txt', '.vtt', '.srt'].includes(ext)) return 'transcript';
  if (ext === '.json') return 'json';
  if (['.m4a', '.mp3', '.wav', '.ogg', '.opus', '.aac'].includes(ext)) return 'audio';
  return 'video';
}

function finishStage(
  stage: JobStageView,
  status: Exclude<JobStageStatus, 'waiting' | 'running'>,
  at: string,
): void {
  stage.status = status;
  stage.finishedAt = at;
}

function shellish(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a;
}

function setupLabel(input: StartSetupJob): string {
  return `Set up ${input.model ? `${input.tool} ${input.model}` : input.tool}`;
}

function setupArgs(input: StartSetupJob): string[] {
  const a = ['--tool', input.tool];
  if (input.model) a.push('--model', input.model);
  if (input.variant) a.push('--variant', input.variant);
  if (input.sha256) a.push('--expect-sha256', input.sha256);
  return a;
}

function lastErrorLine(log: string): string | undefined {
  const lines = log
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const marked = [...lines].reverse().find((l) => l.startsWith('✘') || /error/i.test(l));
  return marked ?? lines[lines.length - 1];
}

export function ensureUploadsDir(journalDir: string): void {
  const dir = join(journalDir, '_uploads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
