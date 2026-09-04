#!/usr/bin/env node
// Topic review: ask the pair's extract model to propose changes to the
// section's topic catalogue (<section>/_topics.json) from local statistics
// and the per-lesson suggestions accumulated by extract.ts. NEVER sends
// lesson content to the model; the payload is bounded by catalogue size,
// not lesson count.
//
// Output: <section>/_topic-reviews/YYYY-MM-DD.md, a markdown report.
// Additions are applied to _topics.json straight away; removals, splits and
// merges stay suggestions. Started from the Settings page (a job) or the CLI.
//
// Usage:
//   tsx scripts/review-vocab.ts --section es-en          # call the model, write report
//   tsx scripts/review-vocab.ts --section es-en --dry    # compute stats only, no API call

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TopicCatalogT } from '../src/lib/schema.ts';
import { computeVocabStats, renderStatsForAI } from './lib/vocab-stats.ts';
import { addTopic, regexSource } from './lib/vocab-apply.ts';
import { learnerLanguageName, targetLanguageName } from './lib/config.ts';
import { readTopicCatalog, resolveSectionArg, sectionDir, topicsPath, writeTopicCatalog } from './lib/journal.ts';
import { getExtractor } from './providers/index.ts';

const dry = process.argv.includes('--dry');

// ── Proposal tool ─────────────────────────────────────────────────────────────

const reviewTool = (catalog: TopicCatalogT) => {
  const categoryIds = catalog.categories.map((c) => c.id);
  return {
    name: 'propose_vocab_changes',
    description:
      'Propose topic additions, removals, splits, merges, or concerns based on the provided stats. Every proposal must cite specific numbers from the stats.',
    input_schema: {
      type: 'object',
      required: ['additions', 'removals', 'splits', 'merges', 'concerns', 'summary'],
      properties: {
        summary: {
          type: 'string',
          description: 'One paragraph: overall state of the catalogue and key actions proposed.',
        },
        additions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'categories', 'regex_patterns', 'reasoning'],
            properties: {
              id: {
                type: 'string',
                pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
                description: 'kebab-case topic id to add to the catalogue.',
              },
              categories: {
                type: 'array',
                items: categoryIds.length > 0 ? { type: 'string', enum: categoryIds } : { type: 'string' },
                description:
                  'Cheat-sheet categories a lesson with this topic can change. Empty for a pure vocabulary theme (food, family, travel).',
              },
              regex_patterns: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                description:
                  'Regex sources (matched case-insensitively) that find the topic in transcript text. Cover target-language terms and learner-language equivalents where applicable.',
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
};

const systemPrompt = (catalog: TopicCatalogT): string => {
  const TARGET = targetLanguageName();
  const LEARNER = learnerLanguageName();
  const categories =
    catalog.categories.map((c) => `  - "${c.id}": ${c.title}`).join('\n') || '  (none yet)';
  return `You are auditing the topic catalogue of a language-lesson journal.

The journal keeps a catalogue of topics per language pair: a finite list of grammar / theme topic ids assigned to each lesson. Topics power "related lesson" candidate filtering during AI extraction and decide which cheat-sheet categories a lesson can change. Quality of the catalogue directly affects recommendation quality.

CHEAT-SHEET CATEGORIES a topic may name:
${categories}

You receive ONLY aggregated statistics — never lesson content. Reason from the numbers.

PROPOSE ADDITIONS when:
  - A suggestion has been accumulated 3+ times across distinct lessons
  - It represents a concept the existing catalogue doesn't cover
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
  - For additions, provide regex sources (no surrounding slashes; matching
    is case-insensitive). ${TARGET} terms appear verbatim in transcripts;
    ${LEARNER} equivalents are useful but only where the term is commonly
    used. Don't invent ${LEARNER} terms you're not sure exist.
  - kebab-case for all topic ids

YOU MUST call propose_vocab_changes exactly once with all five arrays
populated (use empty arrays where nothing applies).`;
};

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const section = resolveSectionArg(process.argv);
  console.log(`Section: ${section.id}`);
  const catalog = readTopicCatalog(section.id);
  const stats = computeVocabStats(sectionDir(section.id), catalog);
  console.log(`Computed stats for ${stats.total_lessons} lesson(s), catalogue size ${stats.vocab_size}.`);

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
      `Only ${stats.total_lessons} lessons — too few for a meaningful topic review. Skipping.`,
    );
    return;
  }

  const extractor = getExtractor();
  const tool = reviewTool(catalog);
  const userPayload = renderStatsForAI(stats);
  console.log(`Asking ${extractor.driver} with ${userPayload.length} chars of stats...`);

  const proposal = normalizeProposal(
    await extractor.extract({
      system: systemPrompt(catalog),
      userParts: [{ type: 'text', text: userPayload }],
      jsonSchema: tool.input_schema,
      toolName: tool.name,
      toolDescription: tool.description,
    }),
  );
  const reportPath = writeReport(proposal, stats, section.id);
  console.log(`✓ Report written: ${reportPath}`);

  // Apply ONLY additions. Removals, splits and merges stay markdown-only
  // suggestions: removing a topic needs human judgment, while an addition
  // is safe — a new topic never strips an existing lesson's tags.
  const applyResult = applyProposal(proposal, catalog, section.id);
  if (applyResult.additions > 0) {
    console.log(`✓ Applied ${applyResult.additions} addition(s) to ${topicsPath(section.id)}`);
  } else {
    console.log('No additions to apply — _topics.json unchanged.');
  }
}

interface ApplyResult {
  additions: number;
  errors: string[];
}

// Apply ONLY the proposal's additions to the catalogue. Any single failure is
// logged but doesn't abort the rest; the file is written once at the end.
function applyProposal(p: VocabProposal, catalog: TopicCatalogT, sectionId: string): ApplyResult {
  const result: ApplyResult = { additions: 0, errors: [] };
  let next = catalog;
  for (const a of p.additions) {
    try {
      const before = next;
      next = addTopic(next, { id: a.id, categories: a.categories, patterns: a.regex_patterns });
      if (next !== before) result.additions += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`add ${a.id}: ${msg}`);
      console.warn(`⚠ Could not apply addition ${a.id}: ${msg}`);
    }
  }
  if (next !== catalog) writeTopicCatalog(sectionId, next);
  return result;
}

// A cloud API enforces the schema; a small local model may leave an array
// out or answer with one `category` string. Missing lists become empty so
// the report and apply steps never crash.
function normalizeProposal(raw: unknown): VocabProposal {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = <T>(key: string): T[] =>
    Array.isArray(o[key]) ? (o[key] as unknown[]).filter((x): x is T => !!x && typeof x === 'object') : [];
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
  return {
    summary: typeof o['summary'] === 'string' ? o['summary'] : '(no summary)',
    additions: list<Record<string, unknown>>('additions')
      .filter((a) => typeof a['id'] === 'string')
      .map((a) => ({
        id: a['id'] as string,
        categories: strings(a['categories'] ?? a['category']),
        regex_patterns: strings(a['regex_patterns']),
        reasoning: typeof a['reasoning'] === 'string' ? a['reasoning'] : '',
      })),
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
    categories: string[];
    regex_patterns: string[];
    reasoning: string;
  }[];
  removals: { id: string; reasoning: string }[];
  splits: { from: string; into: string[]; reasoning: string }[];
  merges: { from: string[]; into: string; reasoning: string }[];
  concerns: { topic: string; issue: string; suggestion?: string }[];
}

// Render the proposal as a markdown report next to the catalogue it reviews.
function writeReport(
  p: VocabProposal,
  stats: { computed_at: string; total_lessons: number; vocab_size: number },
  sectionId: string,
): string {
  const reviewsDir = join(sectionDir(sectionId), '_topic-reviews');
  mkdirSync(reviewsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(reviewsDir, `${date}.md`);

  const lines: string[] = [];
  lines.push(`# Topic review — ${date}`);
  lines.push('');
  lines.push(
    `Generated against ${stats.total_lessons} lesson(s), catalogue size ${stats.vocab_size}. ` +
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
    lines.push(`✅ **No changes proposed.** The catalogue is healthy.`);
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    return path;
  }

  // ── Additions ──
  if (p.additions.length > 0) {
    lines.push(`## Additions (${p.additions.length}) — **applied**`);
    lines.push('');
    for (const a of p.additions) {
      lines.push(`### \`${a.id}\` — categories: ${a.categories.join(', ') || '(none)'}`);
      lines.push('');
      lines.push(`**Reasoning:** ${a.reasoning}`);
      lines.push('');
      lines.push(`**Applied patterns:**`);
      lines.push('');
      lines.push('```');
      for (const re of a.regex_patterns) {
        lines.push(regexSource(re));
      }
      lines.push('```');
      lines.push('');
      lines.push(`→ Applied in \`_topics.json\`. To reject it, remove the entry there.`);
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
        `core tense — needs human judgment). To accept one, delete its entry from ` +
        `\`_topics.json\`; lessons keep the tag until they are re-tagged.`,
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
      lines.push(
        `Manual step: replace the single topic with the split topics in \`_topics.json\`. Existing lessons will need manual re-categorization since patterns can't infer which split each lesson belongs to.`,
      );
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

- **Additions** above are **already applied** to \`_topics.json\`. To undo one, remove its entry.
- **Removals / splits / merges** are **suggestions only — not applied**. Act on them by editing \`_topics.json\` if you agree.
- **Concerns** are advisory, no action proposed.

When the catalogue changes, the next \`backfill-topics --auto\` run detects it and adds the new tags to older lessons; it never removes a tag.`,
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
