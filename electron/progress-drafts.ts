import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SectionConfig } from '../src/lib/journal-config.ts';
import { ProgressDraft } from '../src/lib/progress-draft.ts';
import { atomicReplace } from '../scripts/lib/file-commit.ts';

export function desktopProgressDraft(
  directory: string,
  journal: string,
  section: string,
  value?: unknown,
): { value: unknown; error?: string } {
  try {
    SectionConfig.shape.id.parse(section);
    const key = createHash('sha256').update(resolve(journal)).digest('hex');
    const path = join(directory, `${key}-${section}.json`);
    if (value !== undefined) {
      if (value === null) rmSync(path, { force: true });
      else {
        const text = JSON.stringify(ProgressDraft.parse(value));
        if (Buffer.byteLength(text) > 8 * 1024 * 1024)
          throw new Error('Progress draft is too large');
        mkdirSync(directory, { recursive: true });
        atomicReplace(path, text);
      }
    }
    return {
      value: existsSync(path) ? ProgressDraft.parse(JSON.parse(readFileSync(path, 'utf8'))) : null,
    };
  } catch (error) {
    return { value: null, error: (error as Error).message };
  }
}
