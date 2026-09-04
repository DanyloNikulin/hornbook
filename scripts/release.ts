#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './lib/is-main.ts';
import { packageRoot } from './lib/runtime.ts';
import { releaseMetadata } from './lib/release.ts';

export function main(argv: readonly string[]): void {
  const root = packageRoot(import.meta.url);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const metadata = releaseMetadata(
    readFileSync(join(root, 'package.json'), 'utf8'),
    readFileSync(join(root, 'package-lock.json'), 'utf8'),
    readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    value('--tag'),
  );
  const output = value('--output');
  if (output) writeFileSync(resolve(output), `${metadata.notes}\n`, 'utf8');
  console.log(`Hornbook ${metadata.version} is release-ready (${metadata.tag}).`);
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`✘ ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
