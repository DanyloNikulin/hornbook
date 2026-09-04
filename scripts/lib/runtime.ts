import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Find the package root from source, compiled output, or an Electron asar. */
export function packageRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find Hornbook package root from ${fileURLToPath(fromUrl)}`);
}

/** Read the application version from the package that owns this runtime. */
export function packageVersion(root: string): string {
  const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (typeof raw.version !== 'string' || !semver.test(raw.version)) {
    throw new Error(`Invalid Hornbook version in ${join(root, 'package.json')}`);
  }
  return raw.version;
}
