// Extract through a coding CLI already signed in on this computer
// (Claude Code, Codex, Grok, or Kimi). No API key is stored in the journal.
//
// The CLIs are interactive coding agents; each is run headless the way it
// takes a one-shot prompt, and one JSON object is parsed out of the answer.
// They have no tool-call or structured-output channel, so the lesson JSON
// Schema travels inside the prompt. Images are not sent: slides are skipped.
//
//   claude -p     prompt on stdin; --output-format json wraps the answer in {result}
//   codex exec    prompt on stdin; the last message is also written to a file (-o)
//   grok          --prompt-file; --output-format json wraps the answer in {text}
//   kimi -p       ignores stdin and takes the prompt as an argument, which
//                 Windows caps at 32k characters, so it is asked to read
//                 prompt.txt from its working folder; stream-json keeps
//                 stdout to one JSON line per message

import { ProcessSupervisor } from '../lib/process-supervisor.ts';
import { spawnProcess } from '../lib/process.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasPathSeparator, resolveCli } from '../lib/cli-path.ts';
import type { ExtractRequest, Extractor } from './types.ts';

export type CodingCliKind = 'claude' | 'codex' | 'grok' | 'kimi';

export const CODING_CLIS: readonly CodingCliKind[] = ['claude', 'codex', 'grok', 'kimi'];

/** Environment variable holding the full path when the CLI is not on PATH. */
export const CLI_BIN_ENV: Record<CodingCliKind, string> = {
  claude: 'CLAUDE_BIN',
  codex: 'CODEX_BIN',
  grok: 'GROK_BIN',
  kimi: 'KIMI_BIN',
};

const DRIVER: Record<CodingCliKind, 'claude-cli' | 'codex-cli' | 'grok-cli' | 'kimi-cli'> = {
  claude: 'claude-cli',
  codex: 'codex-cli',
  grok: 'grok-cli',
  kimi: 'kimi-cli',
};

export interface CliCommand {
  bin: string;
  args: string[];
  /** Piped to the CLI; the others read the prompt from prompt.txt in the work folder. */
  stdin?: string;
  /** The CLI writes its last message here; stdout is the fallback. */
  answerFile?: string;
}

export class CliExtractor implements Extractor {
  readonly driver: (typeof DRIVER)[CodingCliKind];
  timeoutMs = 8 * 60 * 1000;

  constructor(
    private readonly kind: CodingCliKind,
    private readonly model: string,
  ) {
    this.driver = DRIVER[kind];
  }

  hasVision(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async extract(req: ExtractRequest): Promise<unknown> {
    req.signal?.throwIfAborted();
    const prompt = buildCliPrompt(req);
    const dir = mkdtempSync(join(tmpdir(), 'hornbook-cli-extract-'));
    writeFileSync(join(dir, 'prompt.txt'), prompt, 'utf8');
    try {
      const cmd = cliCommand(this.kind, this.model, prompt, dir);
      const bin = resolveCli(cmd.bin, process.env);
      if (!bin) throw new Error(missingCliMessage(this.kind, cmd.bin));
      const { code, out, err } = await runProcess(bin, cmd.args, cmd.stdin, req.timeoutMs ?? this.timeoutMs, dir, req.signal);
      if (code !== 0) {
        throw new Error(`Extract ${this.driver} exited ${code}: ${(err || out).slice(0, 800)}`);
      }
      const saved = cmd.answerFile && existsSync(cmd.answerFile) ? readFileSync(cmd.answerFile, 'utf8') : '';
      const answer = saved.trim() || out;
      try {
        return parseCliLesson(answer);
      } catch (e) {
        throw new Error(`Extract ${this.driver}: ${(e as Error).message}. Output: ${answer.slice(0, 400)}`, { cause: e });
      }
    } finally {
      removeExtractDir(dir);
    }
  }
}

/** System prompt, the text parts, then the schema the answer must match. */
export function buildCliPrompt(req: ExtractRequest): string {
  const text = req.userParts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n\n');
  const about = req.toolDescription ? ` ${req.toolDescription}` : '';
  return [
    req.system,
    '',
    text,
    '',
    `There is no ${req.toolName} tool here and no tool is needed: reply with ONLY the JSON object that would be its input.${about}`,
    'It must match this JSON Schema. No markdown fence, no prose before or after it.',
    JSON.stringify(req.jsonSchema),
  ].join('\n');
}

/** What to run for one CLI. `dir` holds prompt.txt with the full prompt. */
export function cliCommand(
  kind: CodingCliKind,
  model: string,
  prompt: string,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): CliCommand {
  const bin = env[CLI_BIN_ENV[kind]]?.trim() || kind;
  const name = model.trim();
  const named = name && name !== '-' && name !== 'default' ? name : undefined;
  const promptFile = join(dir, 'prompt.txt');
  if (kind === 'claude') {
    const args = ['-p', '--output-format', 'json', '--tools', '', '--permission-mode', 'dontAsk'];
    if (named) args.push('--model', named);
    return { bin, args, stdin: prompt };
  }
  if (kind === 'codex') {
    // `codex exec` is already non-interactive; it rejects the approval flag
    // of the top-level command.
    const answerFile = join(dir, 'answer.txt');
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', answerFile];
    if (named) args.push('-m', named);
    return { bin, args, stdin: prompt, answerFile };
  }
  if (kind === 'grok') {
    // Its tools cannot be switched off (an empty --tools list changes
    // nothing), and a stray tool call costs a turn, so leave room for a few.
    const args = [
      '--prompt-file',
      promptFile,
      '--output-format',
      'json',
      '--max-turns',
      '6',
      '--permission-mode',
      'dontAsk',
      '--disallowed-tools',
      'Agent',
      '--verbatim',
    ];
    if (named) args.push('-m', named);
    return { bin, args };
  }
  const args = [
    '-p',
    'Read the file prompt.txt in the current directory and follow it exactly. Reply with only the JSON object it asks for. Do not create or edit any file.',
    '--output-format',
    'stream-json',
  ];
  if (named) args.push('-m', named);
  return { bin, args };
}

export function missingCliMessage(kind: CodingCliKind, bin: string): string {
  return hasPathSeparator(bin)
    ? `No ${kind} CLI at ${bin}.`
    : `The ${kind} CLI is not on PATH. Install it, or set ${CLI_BIN_ENV[kind]} to its full path.`;
}

/** Pull the answer object out of what a CLI printed: plain JSON, a result wrapper, one JSON line per message, or a fenced block. */
export function parseCliLesson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('empty output');

  const direct = tryParse(trimmed);
  if (direct !== undefined) return unwrapCliResult(direct);

  // One JSON object per line (Kimi stream-json): the last message carrying
  // an object wins, after version lines, tool calls and the file it read.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = tryParse(lines[i]!);
      if (!line || typeof line !== 'object') continue;
      if (isAnswerLike(line)) return line;
      const inner = unwrapCliResult(line);
      if (inner !== line) return inner;
    }
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const blob = fence?.[1]?.trim() ?? trimmed;
  const start = blob.indexOf('{');
  const end = blob.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('did not return JSON');
  const inner = tryParse(blob.slice(start, end + 1));
  if (inner === undefined) throw new Error('JSON was not valid');
  return unwrapCliResult(inner);
}

function isAnswerLike(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o['slug'] === 'string' || typeof o['title'] === 'string';
}

function unwrapCliResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (isAnswerLike(value)) return value;
  const o = value as Record<string, unknown>;
  for (const key of ['result', 'text', 'content', 'message']) {
    const result = o[key];
    if (typeof result === 'string') {
      const parsed = tryParse(result);
      if (parsed !== undefined) return unwrapCliResult(parsed);
      const start = result.indexOf('{');
      const end = result.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const nested = tryParse(result.slice(start, end + 1));
        if (nested !== undefined) return unwrapCliResult(nested);
      }
    } else if (result && typeof result === 'object') {
      const nested = unwrapCliResult(result);
      if (nested !== result) return nested;
      if (isAnswerLike(nested)) return nested;
    }
  }
  return value;
}

/** Best-effort: on Windows the CLI may still hold the temp folder after exit. */
export function removeExtractDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw e;
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function runProcess(
  bin: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number; out: string; err: string }> {
  signal?.throwIfAborted();
  const child = spawnProcess(bin, args, {
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    cwd,
  });
  const supervised = new ProcessSupervisor(child, { ownsProcessGroup: process.platform !== 'win32', timeoutMs, onTerminationError: (error) => console.error(`Extract cleanup failed: ${error.message}`) });
  const cancel = () => { void supervised.stop('Extract cancelled').catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  let out = ''; let err = '';
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { out += chunk; });
  child.stderr?.on('data', (chunk: string) => { err += chunk; });
  if (stdin !== undefined && child.stdin) {
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  }
  return supervised.completion.then(({ code, error }) => {
    if (error) throw new Error(`${bin}: ${error}`);
    return { code, out, err };
  }).finally(() => signal?.removeEventListener('abort', cancel));
}
