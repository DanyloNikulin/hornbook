import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveCli } from './cli-path.ts';

/** Resolve npm's Node shims to their script; never pass arguments through cmd.exe. */
export function processCommand(
  bin: string,
  args: readonly string[],
  env = process.env,
): { bin: string; args: string[] } {
  if (/\.(cjs|mjs|js)$/i.test(bin)) return { bin: process.execPath, args: [resolve(bin), ...args] };
  if (process.platform !== 'win32') return { bin, args: [...args] };
  const resolved = resolveCli(bin, env) ?? bin;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { bin: resolved, args: [...args] };
  const shim = readFileSync(resolved, 'utf8');
  const invocation =
    /(?:"%_prog%"|"[^"\r\n]*node(?:\.exe)?"|\bnode(?:\.exe)?)\s+"(?:%dp0%|%~dp0)[\\/]?([^"%\r\n]+\.(?:cjs|mjs|js))"\s+%\*\s*$/im.exec(
      shim,
    );
  const usesNode =
    !invocation?.[0].startsWith('"%_prog%"') || /SET\s+"?_prog=node(?:\.exe)?"?\s*$/im.test(shim);
  if (!invocation || !usesNode)
    throw new Error(
      `Unsupported Windows shim: ${resolved}. Configure the CLI's native executable or Node entrypoint.`,
    );
  const entry = resolve(dirname(resolved), invocation[1]);
  if (!statSync(entry).isFile()) throw new Error(`Missing Node entrypoint for ${resolved}`);
  return { bin: process.execPath, args: [entry, ...args] };
}

export function spawnProcess(
  bin: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const command = processCommand(bin, args, options.env);
  return spawn(command.bin, command.args, { ...options, shell: false, windowsHide: true });
}
