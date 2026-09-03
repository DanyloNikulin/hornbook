import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * True when the module at `moduleUrl` (pass `import.meta.url`) is the entry
 * point of the current process. Uses pathToFileURL so it works on Windows,
 * where a hand-built `file://` + argv[1] string never matches the real
 * `file:///C:/...` URL.
 */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(resolve(entry)).href;
}
