import { existsSync } from 'node:fs';
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
