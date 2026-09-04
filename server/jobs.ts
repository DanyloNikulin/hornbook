// Pipeline jobs: one queue, one child process at a time, log kept in memory
// and streamed to the UI by polling. Jobs run the existing scripts
// (process, build-cheatsheet, review-vocab) with the journal's connection
// values in their environment, so local drivers (Ollama, whisper-cli) work
// exactly as they do from the command line.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  JobKind,
  JobProgress,
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
const RESULT_MARKER = 'HORNBOOK_RESULT ';
const PROGRESS_MARKER = 'HORNBOOK_PROGRESS ';
const STAGE_MARKER = 'HORNBOOK_STAGE ';
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
}

interface Job extends JobView {
  cmd: string;
  args: string[];
  cleanup?: () => void;
  stageBuffer?: string;
}

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly order: string[] = [];
  private readonly queue: string[] = [];
  private running: { job: Job; child: ChildProcess } | null = null;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly runner: (script: string) => { cmd: string; args: string[] };

  constructor(private readonly opts: JobRunnerOptions) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.runner =
      opts.runner ??
      ((script) => ({ cmd: process.execPath, args: ['--import', 'tsx', join(opts.repoRoot, 'scripts', script)] }));
  }

  /** Validate the request, stage any upload, and queue the job. */
  enqueue(section: string, input: StartJob): JobView {
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

    const { cmd, args } = this.runner(script);
    const createdAt = new Date().toISOString();
    const job: Job = {
      id,
      section,
      kind: input.kind as JobKind,
      status: 'queued',
      label,
      log: '',
      createdAt,
      ...(input.kind === 'process' ? { stages: initialProcessStages(input, createdAt), stageBuffer: '' } : {}),
      cmd,
      args: [...args, ...extra, '--section', section],
      cleanup,
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

  /**
   * Kill the running child and drop the queue. Called when the server
   * shuts down: on Windows a child outlives its parent, and a download or
   * an extraction left running would keep writing into the tools folder.
   */
  stop(): void {
    this.queue.length = 0;
    const running = this.running;
    if (!running) return;
    running.job.log += '\nStopped: the server is shutting down.\n';
    running.child.kill();
    this.finish(running.job, 1, 'stopped with the server');
  }

  /** Resolves when the queue is idle. Tests and graceful shutdown. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.running && this.queue.length === 0) resolve();
        else setTimeout(check, 20);
      };
      check();
    });
  }

  private view(job: Job): JobView {
    const { cmd: _cmd, args: _args, cleanup: _cleanup, stageBuffer: _stageBuffer, ...view } = job;
    return { ...view, log: visibleLog(view.log) };
  }

  private trim(): void {
    while (this.order.length > MAX_JOBS_KEPT) {
      const id = this.order[0];
      const job = this.jobs.get(id);
      if (!job || job.status === 'queued' || job.status === 'running') break;
      this.order.shift();
      this.jobs.delete(id);
    }
  }

  private pump(): void {
    if (this.running) return;
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
      });
    } catch (err) {
      this.finish(job, 1, (err as Error).message);
      return;
    }
    this.running = { job, child };

    const append = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (job.kind === 'process') this.applyStageChunk(job, text);
      job.log += text;
      if (job.log.length > MAX_LOG_CHARS) job.log = '…' + job.log.slice(-MAX_LOG_CHARS);
      if (text.includes(PROGRESS_MARKER)) job.progress = parseProgress(job.log) ?? job.progress;
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      this.finish(job, 1, err.message);
    });
    child.on('close', (code) => {
      this.finish(job, code ?? 1);
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
      job.result = parseResult(job.log);
    } else {
      job.status = 'failed';
      const active = job.stages?.find((stage) => stage.status === 'running');
      if (active) finishStage(active, 'failed', job.finishedAt);
      job.error = error ?? lastErrorLine(job.log) ?? `exit code ${code}`;
      if (error) job.log += `\n${error}\n`;
    }
    try {
      job.cleanup?.();
    } catch {
      // an upload that failed to delete is not worth failing the job over
    }
    if (this.running?.job === job) this.running = null;
    this.opts.onFinish?.(this.view(job));
    this.pump();
    this.changed();
  }

  private changed(): void {
    this.opts.onChange?.(this.activeCount());
  }

  private applyStageChunk(job: Job, text: string): void {
    const lines = `${job.stageBuffer ?? ''}${text}`.split(/\r?\n/);
    job.stageBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseStageEvent(line);
      if (!event) continue;
      const stage = job.stages?.find((candidate) => candidate.id === event.id);
      if (!stage) continue;
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
}

function initialProcessStages(input: StartProcessJob, createdAt: string): JobStageView[] {
  const from = input.from ?? inferProcessSource(input.filename);
  return PROCESS_STAGES.map((id) => {
    const skipped =
      (id === 'hearing' && (from === 'transcript' || from === 'json')) ||
      (id === 'slides' && from !== 'video') ||
      (id === 'writing' && from === 'json');
    return skipped ? { id, status: 'skipped', startedAt: createdAt, finishedAt: createdAt } : { id, status: 'waiting' };
  });
}

function inferProcessSource(filename: string): NonNullable<StartProcessJob['from']> {
  const ext = extname(filename).toLowerCase();
  if (['.txt', '.vtt', '.srt'].includes(ext)) return 'transcript';
  if (ext === '.json') return 'json';
  if (['.m4a', '.mp3', '.wav', '.ogg', '.opus', '.aac'].includes(ext)) return 'audio';
  return 'video';
}

function finishStage(stage: JobStageView, status: Exclude<JobStageStatus, 'waiting' | 'running'>, at: string): void {
  stage.status = status;
  stage.finishedAt = at;
}

function parseStageEvent(line: string): { id: ProcessStageId; status: Exclude<JobStageStatus, 'waiting' | 'failed'> } | undefined {
  if (!line.startsWith(STAGE_MARKER)) return undefined;
  try {
    const raw = JSON.parse(line.slice(STAGE_MARKER.length)) as { id?: unknown; status?: unknown };
    if (
      typeof raw.id === 'string' &&
      PROCESS_STAGES.includes(raw.id as ProcessStageId) &&
      (raw.status === 'running' || raw.status === 'done' || raw.status === 'skipped')
    ) {
      return { id: raw.id as ProcessStageId, status: raw.status };
    }
  } catch {
    // Malformed status lines stay harmless log text.
  }
  return undefined;
}

function visibleLog(log: string): string {
  return log
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(STAGE_MARKER))
    .join('\n');
}

function shellish(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a;
}

function parseResult(log: string): JobView['result'] {
  const idx = log.lastIndexOf(RESULT_MARKER);
  if (idx === -1) return undefined;
  const line = log.slice(idx + RESULT_MARKER.length).split('\n')[0];
  try {
    return JSON.parse(line) as JobView['result'];
  } catch {
    return undefined;
  }
}

function parseProgress(log: string): JobProgress | undefined {
  const idx = log.lastIndexOf(PROGRESS_MARKER);
  if (idx === -1) return undefined;
  const line = log.slice(idx + PROGRESS_MARKER.length).split('\n')[0];
  try {
    const raw = JSON.parse(line) as Partial<JobProgress>;
    if (typeof raw.pct !== 'number') return undefined;
    return {
      pct: Math.max(0, Math.min(100, raw.pct)),
      ...(typeof raw.bytes === 'number' ? { bytes: raw.bytes } : {}),
      ...(typeof raw.total === 'number' ? { total: raw.total } : {}),
      ...(typeof raw.stage === 'string' ? { stage: raw.stage } : {}),
    };
  } catch {
    return undefined;
  }
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
