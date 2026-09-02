// Hash of the topics-tagger configuration. Used by backfill-topics --auto to
// decide whether old lessons need re-tagging.
//
// Inputs to the hash:
//   1. TOPIC_VOCAB array (canonical order matters — appending a new topic
//      changes the hash but reordering does too; we re-sort to be stable).
//   2. The full source of scripts/lib/topics.ts (regex patterns + helpers).
//
// Any edit to either invalidates the hash and triggers a full re-backfill on
// the next prebuild. The hash is truncated to 16 hex chars (64 bits) — plenty
// for collision avoidance at our scale.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOPIC_VOCAB } from '../../src/lib/schema.ts';

export function computeTopicsHash(): string {
  const topicsTsPath = fileURLToPath(new URL('./topics.ts', import.meta.url));
  // Normalize line endings: with core.autocrlf the working copy is CRLF on
  // Windows and LF on Linux/CI, and hashing raw bytes gave a different
  // "tagger version" per platform — every cross-platform run looked like a
  // tagger change and re-backfilled everything.
  const topicsSource = readFileSync(topicsTsPath, 'utf8').replace(/\r\n?/g, '\n');
  // Sort vocab so reorderings don't change the hash. We intentionally treat
  // the act of adding a new topic as a real change (so the hash bumps), but
  // alphabetizing for readability shouldn't trigger re-backfill.
  const vocabSorted = [...TOPIC_VOCAB].sort().join('\n');

  return createHash('sha256')
    .update(topicsSource)
    .update('\n---\n')
    .update(vocabSorted)
    .digest('hex')
    .slice(0, 16);
}
