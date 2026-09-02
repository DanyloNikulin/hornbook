#!/usr/bin/env node
// Monthly vocab review: ask Claude to propose vocab changes based on local
// statistics + accumulated per-lesson suggestions. NEVER sends lesson content
// to the AI — the payload is bounded by vocab size, not lesson count.
//
// Output: docs/vocab-reviews/YYYY-MM-DD.md — a markdown report with copy-paste
// snippets ready to apply. Auto-PR is opened by .github/workflows/vocab-review.yml.
//
// Usage:
//   tsx scripts/review-vocab.ts          # call Claude, write report
//   tsx scripts/review-vocab.ts --dry    # compute stats only, no API call

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { Message, Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { computeVocabStats, renderStatsForAI } from './lib/vocab-stats.ts';
import { addToVocabSource, addToPatternsSource, addToCategoryMapSource } from './lib/vocab-apply.ts';
import { learnerLanguageName, targetLanguageName } from './lib/config.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lessonsDir = join(repoRoot, 'lessons');
const reviewsDir = join(repoRoot, 'docs', 'vocab-reviews');
const SCHEMA_PATH = join(repoRoot, 'src/lib/schema.ts');
const TOPICS_PATH = join(repoRoot, 'scripts/lib/topics.ts');
const CATEGORY_MAP_PATH = join(repoRoot, 'scripts/lib/topic-to-category.ts');

const MODEL = process.env['CLAUDE_MODEL'] || 'claude-sonnet-4-6';

const dry = process.argv.includes('--dry');

// Minimum number of lessons ADDED (since the latest review file) required to
// actually call Claude. Set via MIN_NEW_LESSONS env var. 0 disables the gate.
// Used by the CI workflow to skip pushes that didn't add new content. Only
// added lesson files count: a re-tag, a slug repair or any other edit to
// existing lessons is not new material and must not spend a review (it did,
// twice on 2026-09-02, before this counted additions only). First-ever run
// (no prior review) is always allowed through.
const MIN_NEW_LESSONS = Math.max(0, parseInt(process.env['MIN_NEW_LESSONS'] ?? '0', 10) || 0);

// Counts how many lesson .json files were ADDED in git history since the
// most recent docs/vocab-reviews/*.md was committed. Returns:
//   { count: -1, lastReview: null }  — no prior review exists; gate is bypassed
//   { count: N, lastReview: "..." }  — N lesson files added since then
// On a git failure (shallow clone, missing history) it returns count=0 so the
// gate SKIPS: spending a Claude call on unknown state is the wrong default.
// The workflow checks out with fetch-depth 0, so this should not happen; if
// it does, the log line says why.
function countLessonsSinceLastReview(): { count: number; lastReview: string | null } {
  if (!existsSync(reviewsDir)) return { count: -1, lastReview: null };
  const reviews = readdirSync(reviewsDir).filter((f) => f.endsWith('.md')).sort();
  if (reviews.length === 0) return { count: -1, lastReview: null };

  const latest = reviews[reviews.length - 1];
  const relPath = `docs/vocab-reviews/${latest}`;
  try {
    const sha = execSync(`git log -1 --format=%H -- "${relPath}"`, {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    if (!sha) return { count: -1, lastReview: latest };

    // --diff-filter=A: additions only. Renames show as R (not A) with git's
    // default rename detection, so a repaired slug does not count either.
    const diff = execSync(
      `git diff --name-only --diff-filter=A ${sha} HEAD -- "lessons/*.json" ":(exclude)lessons/_*.json"`,
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    const count = diff ? diff.split('\n').length : 0;
    return { count, lastReview: latest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`⚠ Could not count lessons since last review (${msg}). Skipping the review rather than spending on unknown state.`);
    return { count: 0, lastReview: latest };
  }
}

// ── Claude tool ─────────────────────────────────────────────────────────────

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

const TARGET = targetLanguageName();
const LEARNER = learnerLanguageName();

const SYSTEM_PROMPT = `You are auditing the topic vocabulary of a language-lesson catalog.

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

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const stats = computeVocabStats(lessonsDir);
  console.log(`Computed stats for ${stats.total_lessons} lesson(s), vocab size ${stats.vocab_size}.`);

  if (dry) {
    console.log('\n=== Stats payload (dry-run) ===\n');
    console.log(renderStatsForAI(stats));
    console.log('\nDry-run: not calling Claude.');
    return;
  }

  if (!process.env['ANTHROPIC_API_KEY']) {
    throw new Error('ANTHROPIC_API_KEY env var is required');
  }

  // Refuse to call Claude with implausibly thin data — saves money and avoids
  // garbage proposals.
  if (stats.total_lessons < 10) {
    console.log(
      `Only ${stats.total_lessons} lessons — too few for a meaningful vocab review. Skipping.`,
    );
    return;
  }

  // Skip if not enough lessons committed since the last review. First-ever
  // run (no prior review) is always allowed through.
  if (MIN_NEW_LESSONS > 0) {
    const { count, lastReview } = countLessonsSinceLastReview();
    if (lastReview && count >= 0 && count < MIN_NEW_LESSONS) {
      console.log(
        `Only ${count} new lesson(s) since last review (${lastReview}). Threshold MIN_NEW_LESSONS=${MIN_NEW_LESSONS}. Skipping.`,
      );
      return;
    }
    if (lastReview) {
      console.log(`${count} new lesson(s) since last review (${lastReview}) — proceeding.`);
    } else {
      console.log('No prior review — running first vocab audit.');
    }
  }

  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
  const userPayload = renderStatsForAI(stats);
  console.log(`Calling ${MODEL} with ${userPayload.length} chars of stats...`);

  const tools: Tool[] = [REVIEW_TOOL as Tool];
  const resp: Message = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: 'tool', name: REVIEW_TOOL.name },
    messages: [{ role: 'user', content: userPayload }],
  });

  console.log(
    `Tokens: in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} stop=${resp.stop_reason}`,
  );

  const toolUse = resp.content.find(
    (c): c is ToolUseBlock => c.type === 'tool_use' && c.name === REVIEW_TOOL.name,
  );
  if (!toolUse) {
    throw new Error(`Claude did not call ${REVIEW_TOOL.name}. Stop reason: ${resp.stop_reason}`);
  }

  const proposal = toolUse.input as VocabProposal;
  const reportPath = writeReport(proposal, stats);
  console.log(`✓ Report written: ${reportPath}`);

  // Auto-apply ONLY additions to schema.ts and topics.ts. Removals, splits and
  // merges stay markdown-only suggestions: now that the review auto-merges to
  // main, removing a topic (e.g. an as-yet-unused core tense) needs human
  // judgment — additions are safe, a new topic never strips an existing
  // lesson's tags.
  const applyResult = applyProposal(proposal);
  if (applyResult.changedFiles.length > 0) {
    console.log(
      `✓ Applied ${applyResult.additions} addition(s) to: ${applyResult.changedFiles.join(', ')}`,
    );
  } else {
    console.log('No additions to apply — schema.ts and topics.ts unchanged.');
  }

  // For CI: emit the report path as GITHUB_OUTPUT so the workflow can decide
  // whether to open a PR.
  if (process.env['GITHUB_OUTPUT']) {
    writeFileSync(process.env['GITHUB_OUTPUT'], `report_path=${reportPath}\n`, { flag: 'a' });
  }
}

interface ApplyResult {
  additions: number;
  changedFiles: string[];
  errors: string[];
}

// Apply ONLY the proposal's additions to schema.ts and topics.ts. Removals,
// splits and merges are intentionally NOT auto-applied — they stay markdown
// suggestions for a human to act on (the review auto-merges to main, and
// auto-removing topics is too aggressive). Any single failure is logged but
// doesn't abort the rest. The CI runner commits the code changes in the same
// commit as the markdown report.
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
      // exactly the state that crashed build-cheatsheet — see issue #63).
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
    lines.push(`## Additions (${p.additions.length}) — **applied (auto-committed to main)**`);
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
        `→ Applied in \`src/lib/schema.ts\` and \`scripts/lib/topics.ts\`. ` +
          `To reject this addition, revert it from the \`vocab review\` commit on main.`,
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

This review was **auto-committed straight to main** (no PR).

- **Additions** above are **already applied** in the same commit. To undo one, revert it from the \`vocab review\` commit.
- **Removals / splits / merges** are **suggestions only — not applied**. Act on them manually if you agree.
- **Concerns** are advisory, no action proposed.

When the topics config changes, the next build's \`prebuild\` runs \`backfill-topics --auto\`: it detects the hash change and re-tags every lesson with the new vocab.`,
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
