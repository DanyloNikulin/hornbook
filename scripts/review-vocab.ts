#!/usr/bin/env node
// Monthly vocab review: ask the pair's extract model to propose vocab changes
// based on local statistics + accumulated per-lesson suggestions. NEVER sends lesson content
// to the AI — the payload is bounded by vocab size, not lesson count.
//
// Output: docs/vocab-reviews/YYYY-MM-DD.md — a markdown report. Additions
// are applied to the topic vocabulary straight away; everything else stays
// a suggestion. Started from the Settings page (a job) or from the CLI.
//
// Usage:
//   tsx scripts/review-vocab.ts --section es-en          # call the model, write report
//   tsx scripts/review-vocab.ts --section es-en --dry    # compute stats only, no API call

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVocabStats, renderStatsForAI } from './lib/vocab-stats.ts';
import { addToVocabSource, addToPatternsSource, addToCategoryMapSource } from './lib/vocab-apply.ts';
import { learnerLanguageName, targetLanguageName } from './lib/config.ts';
import { currentSection, resolveSectionArg, sectionDir } from './lib/journal.ts';
import { getExtractor } from './providers/index.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const reviewsDir = join(repoRoot, 'docs', 'vocab-reviews');
const SCHEMA_PATH = join(repoRoot, 'src/lib/schema.ts');
const TOPICS_PATH = join(repoRoot, 'scripts/lib/topics.ts');
const CATEGORY_MAP_PATH = join(repoRoot, 'scripts/lib/topic-to-category.ts');

const dry = process.argv.includes('--dry');

// ── Proposal tool ─────────────────────────────────────────────────────────────

const REVIEW_TOOL = {
  name: 'propose_vocab_changes',
  description:
    'Propose vocab additions, removals, splits, merges, or scope-down concerns based on the provided stats. Every proposal must cite specific numbers from the stats.',
  input_schema: {
    type: 'object',
    required: ['additions', 'removals', 'splits', 'merges', 'concerns', 'summary'],
    properties: {
      summary: {
        type: 'string',
        description: 'One paragraph: overall state of the vocabulary and key actions proposed.',
      },
      additions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'category', 'regex_patterns', 'reasoning'],
          properties: {
            id: {
              type: 'string',
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
              description: 'kebab-case topic ID to add to TOPIC_VOCAB.',
            },
            category: {
              type: 'string',
              enum: [
                'Tenses',
                'Verb classes',
                'Specific common verbs',
                'Articles, nouns, prepositions',
                'Pronouns',
                'Adjectives',
                'Reading & pronunciation',
                'Set-phrase constructions',
                'Themes / vocabulary domains',
              ],
              description: 'Section of TOPIC_VOCAB this belongs in.',
            },
            regex_patterns: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'JavaScript regex literals (with /i flag etc) — one or more patterns that should match the topic in transcript text. Cover target-language terms and learner-language equivalents where applicable.',
            },
            reasoning: {
              type: 'string',
              description: 'Why add this — must cite specific numbers from the stats (e.g. "suggested in 5 lessons since 2026-06").',
            },
          },
        },
      },
      removals: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'reasoning'],
          properties: {
            id: { type: 'string' },
            reasoning: { type: 'string' },
          },
        },
      },
      splits: {
        type: 'array',
        items: {
          type: 'object',
          required: ['from', 'into', 'reasoning'],
          properties: {
            from: { type: 'string' },
            into: { type: 'array', items: { type: 'string' }, minItems: 2 },
            reasoning: { type: 'string' },
          },
        },
      },
      merges: {
        type: 'array',
        items: {
          type: 'object',
          required: ['from', 'into', 'reasoning'],
          properties: {
            from: { type: 'array', items: { type: 'string' }, minItems: 2 },
            into: { type: 'string' },
            reasoning: { type: 'string' },
          },
        },
      },
      concerns: {
        type: 'array',
        items: {
          type: 'object',
          required: ['topic', 'issue'],
          properties: {
            topic: { type: 'string' },
            issue: { type: 'string', description: 'Problem observed, with stats backing.' },
            suggestion: { type: 'string', description: 'Optional: what to do about it.' },
          },
        },
      },
    },
  },
};

const systemPrompt = (): string => {
const TARGET = targetLanguageName();
const LEARNER = learnerLanguageName();
return `You are auditing the topic vocabulary of a language-lesson catalog.

The catalog uses a controlled vocabulary (TOPIC_VOCAB) — a finite list of grammar / theme topic IDs assigned to each lesson. Topics power "related lesson" candidate filtering during AI extraction. Quality of the vocab directly affects recommendation quality.

You receive ONLY aggregated statistics — never lesson content. Reason from the numbers.

PROPOSE ADDITIONS when:
  - A suggestion has been accumulated 3+ times across distinct lessons
  - It represents a concept the existing vocab doesn't cover
  - It's narrow enough to be a useful filter signal (not "${TARGET.toLowerCase()}-language")

PROPOSE REMOVALS when:
  - A topic has 0 uses across all lessons (vestigial)
  - A topic is so broad (>80% density) it can't usefully filter — i.e. it
    matches almost every lesson, so "share this topic" is always true and
    the filter degenerates

PROPOSE SPLITS when:
  - A topic has 10+ uses AND co-occurrence patterns suggest two subtopics
    are bundled (e.g. "verbi-irregolari" co-occurs ~equally with both
    "presente" and "passato-prossimo", suggesting two subkinds bundled)
  - Splitting must produce topics that are meaningfully distinct

PROPOSE MERGES when:
  - Two topics co-occur in >80% of their joint uses (they're effectively
    redundant)
  - Combined they're still narrow enough to be useful

RAISE CONCERNS (no action proposed) when:
  - Stats look unusual but the right action isn't clear
  - Examples: topic with sudden spike, topic stopped being used 6 months ago

HARD RULES:
  - Every proposal MUST cite specific numbers from the stats
  - Empty arrays are acceptable — propose nothing if stats don't justify
  - Be conservative: false-positive proposals waste reviewer time
  - For additions, provide actual JavaScript regex patterns (with /i flag
    where case-insensitive). ${TARGET} terms appear verbatim in transcripts;
    ${LEARNER} equivalents are useful but only where the term is commonly
    used. Don't invent ${LEARNER} terms you're not sure exist.
  - kebab-case for all topic IDs

YOU MUST call propose_vocab_changes exactly once with all five arrays
populated (use empty arrays where nothing applies).`;
};

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const section = resolveSectionArg(process.argv);
  console.log(`Section: ${section.id}`);
  const stats = computeVocabStats(sectionDir(section.id));
  console.log(`Computed stats for ${stats.total_lessons} lesson(s), vocab size ${stats.vocab_size}.`);

  if (dry) {
    console.log('\n=== Stats payload (dry-run) ===\n');
    console.log(renderStatsForAI(stats));
    console.log('\nDry-run: not calling the model.');
    return;
  }

  // Refuse to call the model with implausibly thin data — saves time (and
  // money on a cloud API) and avoids garbage proposals.
  if (stats.total_lessons < 10) {
    console.log(
      `Only ${stats.total_lessons} lessons — too few for a meaningful vocab review. Skipping.`,
    );
    return;
  }

  const extractor = getExtractor();
  const userPayload = renderStatsForAI(stats);
  console.log(`Asking ${extractor.driver} with ${userPayload.length} chars of stats...`);

  const proposal = normalizeProposal(
    await extractor.extract({
      system: systemPrompt(),
      userParts: [{ type: 'text', text: userPayload }],
      jsonSchema: REVIEW_TOOL.input_schema,
      toolName: REVIEW_TOOL.name,
      toolDescription: REVIEW_TOOL.description,
    }),
  );
  const reportPath = writeReport(proposal, stats);
  console.log(`✓ Report written: ${reportPath}`);

  // Apply ONLY additions to schema.ts and topics.ts. Removals, splits and
  // merges stay markdown-only suggestions: removing a topic needs human
  // judgment, while an addition is safe — a new topic never strips an
  // existing lesson's tags.
  const applyResult = applyProposal(proposal);
  if (applyResult.changedFiles.length > 0) {
    console.log(
      `✓ Applied ${applyResult.additions} addition(s) to: ${applyResult.changedFiles.join(', ')}`,
    );
  } else {
    console.log('No additions to apply — schema.ts and topics.ts unchanged.');
  }

}

interface ApplyResult {
  additions: number;
  changedFiles: string[];
  errors: string[];
}

// Apply ONLY the proposal's additions to schema.ts and topics.ts. Removals,
// splits and merges are intentionally NOT auto-applied — they stay markdown
// suggestions for a human to act on. Any single failure is logged but
// doesn't abort the rest.
function applyProposal(p: VocabProposal): ApplyResult {
  const result: ApplyResult = {
    additions: 0,
    changedFiles: [],
    errors: [],
  };

  let schemaSrc = readFileSync(SCHEMA_PATH, 'utf8');
  let topicsSrc = readFileSync(TOPICS_PATH, 'utf8');
  let categoryMapSrc = readFileSync(CATEGORY_MAP_PATH, 'utf8');
  const initialSchema = schemaSrc;
  const initialTopics = topicsSrc;
  const initialCategoryMap = categoryMapSrc;

  // Additions: schema + topics
  for (const a of p.additions) {
    try {
      // All three edits are computed before any is kept: if the category
      // map anchor is missing we must NOT leave the topic half-added (that is
      // exactly the state that crashed build-cheatsheet).
      const nextSchema = addToVocabSource(schemaSrc, a.id, a.category);
      const nextTopics = addToPatternsSource(topicsSrc, a.id, a.category, a.regex_patterns);
      const nextCategoryMap = addToCategoryMapSource(categoryMapSrc, a.id, a.category);
      schemaSrc = nextSchema;
      topicsSrc = nextTopics;
      categoryMapSrc = nextCategoryMap;
      result.additions += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`add ${a.id}: ${msg}`);
      console.warn(`⚠ Could not apply addition ${a.id}: ${msg}`);
    }
  }

  // Removals are intentionally NOT applied — see the function comment. They
  // remain in the markdown report as suggestions for manual review.

  if (schemaSrc !== initialSchema) {
    writeFileSync(SCHEMA_PATH, schemaSrc, 'utf8');
    result.changedFiles.push('src/lib/schema.ts');
  }
  if (topicsSrc !== initialTopics) {
    writeFileSync(TOPICS_PATH, topicsSrc, 'utf8');
    result.changedFiles.push('scripts/lib/topics.ts');
  }
  if (categoryMapSrc !== initialCategoryMap) {
    writeFileSync(CATEGORY_MAP_PATH, categoryMapSrc, 'utf8');
    result.changedFiles.push('scripts/lib/topic-to-category.ts');
  }

  return result;
}

// A cloud API enforces the schema; a small local model may leave an array
// out. Missing lists become empty so the report and apply steps never crash.
function normalizeProposal(raw: unknown): VocabProposal {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = <T>(key: string): T[] =>
    Array.isArray(o[key]) ? (o[key] as unknown[]).filter((x): x is T => !!x && typeof x === 'object') : [];
  return {
    summary: typeof o['summary'] === 'string' ? o['summary'] : '(no summary)',
    additions: list<VocabProposal['additions'][number]>('additions').filter(
      (a) => typeof a.id === 'string' && Array.isArray(a.regex_patterns),
    ),
    removals: list('removals'),
    splits: list('splits'),
    merges: list('merges'),
    concerns: list('concerns'),
  };
}

interface VocabProposal {
  summary: string;
  additions: {
    id: string;
    category: string;
    regex_patterns: string[];
    reasoning: string;
  }[];
  removals: { id: string; reasoning: string }[];
  splits: { from: string; into: string[]; reasoning: string }[];
  merges: { from: string[]; into: string; reasoning: string }[];
  concerns: { topic: string; issue: string; suggestion?: string }[];
}

// Render the proposal as a markdown report with ready-to-copy code snippets.
function writeReport(p: VocabProposal, stats: { computed_at: string; total_lessons: number; vocab_size: number }): string {
  mkdirSync(reviewsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(reviewsDir, `${date}.md`);

  const lines: string[] = [];
  lines.push(`# Vocab review — ${date}`);
  lines.push('');
  lines.push(
    `Generated against ${stats.total_lessons} lesson(s), vocab size ${stats.vocab_size}. ` +
      `Stats computed ${stats.computed_at}.`,
  );
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(p.summary);
  lines.push('');

  const totalChanges =
    p.additions.length + p.removals.length + p.splits.length + p.merges.length;
  if (totalChanges === 0 && p.concerns.length === 0) {
    lines.push(`✅ **No changes proposed.** Vocab is healthy.`);
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    return path;
  }

  // ── Additions ──
  if (p.additions.length > 0) {
    lines.push(`## Additions (${p.additions.length}) — **applied**`);
    lines.push('');
    for (const a of p.additions) {
      lines.push(`### \`${a.id}\` — ${a.category}`);
      lines.push('');
      lines.push(`**Reasoning:** ${a.reasoning}`);
      lines.push('');
      lines.push(`**Applied regex patterns:**`);
      lines.push('');
      lines.push('```ts');
      for (const re of a.regex_patterns) {
        lines.push(`  ${re},`);
      }
      lines.push('```');
      lines.push('');
      lines.push(
        `→ Applied in \`src/lib/schema.ts\`, \`scripts/lib/topics.ts\` and \`scripts/lib/topic-to-category.ts\`. ` +
          `To reject it, remove the id and its patterns from those files.`,
      );
      lines.push('');
    }
  }

  // ── Removals ──
  if (p.removals.length > 0) {
    lines.push(`## Removals (${p.removals.length}) — **suggested only, NOT applied**`);
    lines.push('');
    for (const r of p.removals) {
      lines.push(`- **\`${r.id}\`** — ${r.reasoning}`);
    }
    lines.push('');
    lines.push(
      `→ Removals are **not** auto-applied (deleting a topic — e.g. an as-yet-unused ` +
        `core tense — needs human judgment). To accept one: delete the ID from ` +
        `\`src/lib/schema.ts\` and its pattern block from \`scripts/lib/topics.ts\` ` +
        `manually; the next build's hash-aware backfill then strips it from lessons.`,
    );
    lines.push('');
  }

  // ── Splits ──
  if (p.splits.length > 0) {
    lines.push(`## Splits (${p.splits.length})`);
    lines.push('');
    for (const s of p.splits) {
      lines.push(`### \`${s.from}\` → ${s.into.map((i) => `\`${i}\``).join(' + ')}`);
      lines.push('');
      lines.push(`**Reasoning:** ${s.reasoning}`);
      lines.push('');
      lines.push(`Manual step: replace the single topic with the split topics in vocab + regex. Existing lessons will need manual re-categorization since regex can't infer which split each lesson belongs to.`);
      lines.push('');
    }
  }

  // ── Merges ──
  if (p.merges.length > 0) {
    lines.push(`## Merges (${p.merges.length})`);
    lines.push('');
    for (const m of p.merges) {
      lines.push(`### ${m.from.map((i) => `\`${i}\``).join(' + ')} → \`${m.into}\``);
      lines.push('');
      lines.push(`**Reasoning:** ${m.reasoning}`);
      lines.push('');
    }
  }

  // ── Concerns ──
  if (p.concerns.length > 0) {
    lines.push(`## Concerns (no action proposed)`);
    lines.push('');
    for (const c of p.concerns) {
      lines.push(`- **\`${c.topic}\`**: ${c.issue}${c.suggestion ? ` _Suggestion: ${c.suggestion}_` : ''}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `## How to use this report

- **Additions** above are **already applied** to the topic vocabulary. To undo one, remove the id and its patterns from the three source files.
- **Removals / splits / merges** are **suggestions only — not applied**. Act on them manually if you agree.
- **Concerns** are advisory, no action proposed.

When the topic vocabulary changes, the next start runs \`backfill-topics --auto\`: it detects the change and re-tags every lesson with the new vocabulary.`,
  );

  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error('\n✘', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
