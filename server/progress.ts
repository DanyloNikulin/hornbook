import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Progress, EMPTY_PROGRESS, DerivedCard, type ProgressT } from '../src/lib/schema.ts';
import type { ProgressView } from '../src/lib/api-types.ts';
import { DERIVED_FORMAT_VERSION, type JournalRepository } from '../scripts/lib/journal.ts';
import type { FileChange } from '../scripts/lib/file-commit.ts';
import { buildDerived } from '../scripts/lib/derived.ts';

export class ProgressError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const serialize = (value: ProgressT) => JSON.stringify(value, null, 2) + '\n';

export class JournalProgress {
  constructor(private readonly journal: JournalRepository) {}

  private current(id: string): {
    value: ProgressT;
    revision: string;
    recovery?: string;
    changes: FileChange[];
  } {
    const path = this.journal.progressPath(id);
    const marker = this.journal.sectionPath(id, '_progress-recovery.json');
    if (!existsSync(path)) {
      const recovery = existsSync(marker)
        ? (JSON.parse(readFileSync(marker, 'utf8')).backup as string)
        : undefined;
      return {
        value: structuredClone(EMPTY_PROGRESS),
        revision: hash(recovery ? `recovery:${recovery}` : serialize(EMPTY_PROGRESS)),
        recovery,
        changes: [],
      };
    }
    const raw = readFileSync(path);
    let value: ProgressT;
    try {
      value = Progress.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      const backup = `_progress.corrupt-${hash(raw)}.json`;
      const target = this.journal.sectionPath(id, backup);
      if (existsSync(target) && !readFileSync(target).equals(raw))
        throw new Error('Progress backup already exists with different contents');
      return {
        value: structuredClone(EMPTY_PROGRESS),
        revision: hash(`recovery:${backup}`),
        recovery: backup,
        changes: [
          { path: `${id}/${backup}`, data: raw },
          { path: `${id}/_progress-recovery.json`, data: JSON.stringify({ backup }) },
          { path: `${id}/_progress.json`, data: null },
        ],
      };
    }
    return { value, revision: hash(serialize(value)), changes: [] };
  }

  private view(id: string, value: ProgressT, revision: string, recovery?: string): ProgressView {
    return {
      ...value,
      revision,
      journalKey: hash(this.journal.root),
      ...(recovery ? { recovery } : {}),
    };
  }

  read(id: string): ProgressView {
    return this.journal.commit(() => {
      const current = this.current(id);
      if (current.recovery)
        return {
          changes: current.changes,
          result: this.view(id, current.value, current.revision, current.recovery),
        };
      if (Object.keys(current.value.sm2).length === 0)
        return { changes: [], result: this.view(id, current.value, current.revision) };
      const section = this.journal.getSection(id);
      let cards;
      try {
        const format = JSON.parse(
          readFileSync(this.journal.sectionPath(id, '_derived', 'format.json'), 'utf8'),
        );
        if (format.version === DERIVED_FORMAT_VERSION)
          cards = DerivedCard.array().parse(
            JSON.parse(
              readFileSync(this.journal.sectionPath(id, '_derived', 'cards.json'), 'utf8'),
            ),
          );
      } catch {
        /* Derived files are rebuildable caches. */
      }
      cards ??= buildDerived(
        this.journal.readSectionLessons(id).map((entry) => entry.lesson),
        section.target,
      ).cards;
      const sm2 = { ...current.value.sm2 };
      const migrated = new Set<string>();
      for (const card of cards)
        for (const alias of [...card.source_ids, ...(card.legacy_id ? [card.legacy_id] : [])]) {
          if (alias === card.id || !sm2[alias]) continue;
          if (!sm2[card.id]) sm2[card.id] = sm2[alias];
          migrated.add(alias);
        }
      for (const key of migrated) delete sm2[key];
      // Read compatibility changes the view, not its underlying revision.
      return { changes: [], result: this.view(id, { ...current.value, sm2 }, current.revision) };
    });
  }

  write(id: string, input: unknown, revision?: string, recover = false): ProgressView {
    const parsed = Progress.safeParse(input);
    if (!parsed.success) throw new ProgressError(400, 'Invalid progress');
    return this.journal.commit(() => {
      const current = this.current(id);
      if (revision !== undefined && revision !== current.revision)
        throw new ProgressError(409, 'Progress changed elsewhere. Your unsaved copy is retained.');
      if (current.recovery && !recover)
        throw new ProgressError(409, 'Progress needs explicit recovery before saving');
      const text = serialize(parsed.data);
      return {
        changes: [
          ...current.changes.filter(
            (change) =>
              !change.path.endsWith('/_progress.json') &&
              !change.path.endsWith('/_progress-recovery.json'),
          ),
          { path: `${id}/_progress.json`, data: text },
          { path: `${id}/_progress-recovery.json`, data: null },
        ],
        result: this.view(id, parsed.data, hash(text)),
      };
    });
  }
}
