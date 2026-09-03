// Find a coding CLI the way a shell would. An explicit path is taken as
// given; a bare name is searched on PATH, with PATHEXT on Windows, where npm
// installs `codex` as codex.cmd and Node cannot spawn that by bare name.

import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface ResolveCliOptions {
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

const WINDOWS_EXTS = ['.exe', '.cmd', '.bat', '.com'];

export function hasPathSeparator(bin: string): boolean {
  return bin.includes('/') || bin.includes('\\');
}

/** Full path of the CLI, or undefined when it is not there. */
export function resolveCli(
  bin: string,
  env: NodeJS.ProcessEnv,
  opts: ResolveCliOptions = {},
): string | undefined {
  const exists = opts.exists ?? existsSync;
  const platform = opts.platform ?? process.platform;
  if (hasPathSeparator(bin)) return exists(bin) ? bin : undefined;

  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(windows ? ';' : ':').filter(Boolean);
  const exts = windows ? (env['PATHEXT'] ?? WINDOWS_EXTS.join(';')).split(';').filter(Boolean) : [];
  // A name that already carries an extension (claude.exe) is tried as is.
  const names = windows && !path.extname(bin) ? [] : [bin];
  for (const ext of exts) names.push(bin + ext);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}
