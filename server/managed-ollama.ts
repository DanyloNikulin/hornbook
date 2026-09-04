// Hornbook's own Ollama: the standalone binary from the tools folder, run as
// a child of the server on its own port with its own models directory. No
// tray app, no login item. Not started when an Ollama already answers on the
// configured host.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ManagedOllamaOptions {
  exe: string;
  modelsDir: string;
  port: number;
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** How long to wait for /api/version after spawning. */
  startupMs?: number;
}

const LOG_KEEP = 20_000;

let active: string | undefined;

/** Host of the managed Ollama while it runs; undefined otherwise. Read by pipelineEnv. */
export function activeManagedHost(): string | undefined {
  return active;
}

export class ManagedOllama {
  readonly host: string;
  private child: ChildProcess | null = null;
  private log = '';
  private starting: Promise<boolean> | null = null;

  constructor(private readonly opts: ManagedOllamaOptions) {
    this.host = `http://127.0.0.1:${opts.port}`;
  }

  available(): boolean {
    return (this.opts.exists ?? existsSync)(this.opts.exe);
  }

  running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  logTail(): string {
    return this.log;
  }

  /** Start if the binary is there and it is not running; resolves once /api/version answers. */
  start(): Promise<boolean> {
    if (this.running()) return this.answers(1500);
    if (this.starting) return this.starting;
    if (!this.available()) return Promise.resolve(false);
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<boolean> {
    const spawn = this.opts.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawn(this.opts.exe, ['serve'], {
        env: {
          ...(this.opts.env ?? process.env),
          OLLAMA_HOST: `127.0.0.1:${this.opts.port}`,
          OLLAMA_MODELS: this.opts.modelsDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.note(`could not start: ${(err as Error).message}`);
      return false;
    }
    this.child = child;
    const append = (d: Buffer): void => {
      this.log += d.toString();
      if (this.log.length > LOG_KEEP) this.log = this.log.slice(-LOG_KEEP);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => this.note(`error: ${err.message}`));
    child.on('exit', (code) => {
      this.note(`exited with ${code ?? 'signal'}`);
      if (this.child === child) {
        this.child = null;
        active = undefined;
      }
    });
    const startupMs = this.opts.startupMs ?? 20_000;
    const deadline = Date.now() + startupMs;
    while (Date.now() < deadline && this.running()) {
      if (await this.answers(1000)) {
        active = this.host;
        this.note(`up at ${this.host}`);
        return true;
      }
      await new Promise((r) => setTimeout(r, Math.min(300, startupMs)));
    }
    this.note(`did not answer within ${Math.round(startupMs / 1000)} s`);
    // A server that never answered is not worth keeping around.
    this.stop();
    return false;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    active = undefined;
    if (child && child.exitCode === null) child.kill();
  }

  private async answers(timeoutMs: number): Promise<boolean> {
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.host}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private note(line: string): void {
    this.opts.log?.(`[ollama] ${line}`);
  }
}
