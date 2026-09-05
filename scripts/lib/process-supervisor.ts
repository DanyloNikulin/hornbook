import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface ProcessExit { code: number; error?: string }

export function posixTerminationTargets(root: number, rows: number[][], ownsProcessGroup: boolean): number[] {
  const visited = new Set([root]);
  const descendants = (parent: number): number[] => rows.filter(([pid, ppid]) => ppid === parent && !visited.has(pid)).flatMap(([pid]) => {
    visited.add(pid);
    return [...descendants(pid), pid];
  });
  return [...descendants(root), ...(ownsProcessGroup ? [-root] : []), root];
}

/** Stop only the tree rooted at a child owned by this supervisor. */
export async function terminateProcessTree(child: ChildProcess, ownsProcessGroup: boolean): Promise<void> {
  if (!child.pid) { child.kill(); return; }
  if (process.platform === 'win32') {
    try {
      await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
    return;
  }
  // Include nested process groups (for example a CLI that starts its own session).
  const { stdout } = await exec('ps', ['-eo', 'pid=,ppid='], { timeout: 5000 });
  const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const kill = (pid: number) => {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  for (const pid of posixTerminationTargets(child.pid, rows, ownsProcessGroup)) kill(pid);
}

export class ProcessSupervisor {
  /** Work result may fail before descendants can be released. */
  readonly result: Promise<ProcessExit>;
  /** Resolves only when the owned process tree can safely be released. */
  readonly completion: Promise<ProcessExit>;
  private ending?: Promise<void>;
  private exit?: ProcessExit;
  private cleanupFailed = false;
  private reason?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: (exit: ProcessExit) => void;
  private resolveResult!: (exit: ProcessExit) => void;

  constructor(readonly child: ChildProcess, private readonly options: {
    ownsProcessGroup: boolean;
    timeoutMs?: number;
    timeoutMessage?: string;
    onTerminationError?: (error: Error) => void;
    terminate?: typeof terminateProcessTree;
  }) {
    this.result = new Promise((resolve) => { this.resolveResult = resolve; });
    this.completion = new Promise<ProcessExit>((resolve) => {
      this.resolve = resolve;
      child.once('error', (error) => { this.reason ??= error.message; });
      child.once('close', (code) => {
        this.exit = { code: code ?? 1 };
        clearTimeout(this.timer);
        this.complete();
      });
    });
    if (options.timeoutMs !== undefined) this.timer = setTimeout(() => {
      void this.stop(options.timeoutMessage ?? `Process timed out after ${Math.round(options.timeoutMs! / 1000)}s`).catch(() => undefined);
    }, options.timeoutMs);
  }

  async stop(reason: string): Promise<ProcessExit> {
    if ((!this.exit || this.cleanupFailed) && !this.ending) {
      this.reason = reason;
      clearTimeout(this.timer);
      this.ending = Promise.resolve().then(() => (this.options.terminate ?? terminateProcessTree)(this.child, this.options.ownsProcessGroup))
        .then(() => { this.cleanupFailed = false; }, (error: Error) => {
          this.cleanupFailed = true;
          this.resolveResult({ code: 1, error: `Process cleanup failed: ${error.message}` });
          this.options.onTerminationError?.(error);
          throw error;
        }).finally(() => { this.ending = undefined; this.complete(); });
    }
    await this.ending;
    return this.completion;
  }

  private complete(): void {
    if (this.exit && !this.ending && !this.cleanupFailed) {
      const result = { code: this.reason ? 1 : this.exit.code, ...(this.reason ? { error: this.reason } : {}) };
      this.resolveResult(result);
      this.resolve(result);
    }
  }

  get cleanupPending(): boolean { return !this.exit || !!this.ending || this.cleanupFailed; }
}

/** The caller can report failure without abandoning the process or its scratch files. */
export class ProcessCleanupError extends Error {
  constructor(message: string, readonly owner: ProcessSupervisor) { super(message); }
  async retryCleanup(): Promise<void> { await this.owner.stop('retry process cleanup'); }
}
