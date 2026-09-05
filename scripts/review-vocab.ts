#!/usr/bin/env node
// Topic review: ask the pair's extract model to propose changes to the
// section's topic catalogue (<section>/_topics.json) from local statistics
// and the per-lesson suggestions accumulated by extract.ts. NEVER sends
// lesson content to the model; the payload is bounded by catalogue size,
// not lesson count.
//
// Output: <section>/_topic-reviews/<date>-<unique id>.md, a markdown report.
// Additions are applied to _topics.json straight away; removals, splits and
// merges stay suggestions. Started from the Settings page (a job) or the CLI.
//
// Usage:
//   tsx scripts/review-vocab.ts --section es-en          # call the model, write report
//   tsx scripts/review-vocab.ts --section es-en --dry    # compute stats only, no API call

import { retainFailedCleanup } from './lib/cli-failure.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TopicCatalogT } from '../src/lib/schema.ts';
import { computeVocabStats, renderStatsForAI } from './lib/vocab-stats.ts';
import { applyProposal, normalizeProposal, proposalSchema } from './lib/vocab-proposal.ts';
import { renderProposal } from './lib/vocab-review-report.ts';
import { z } from 'zod';
import { learnerLanguageName, targetLanguageName } from './lib/config.ts';
import { readTopicCatalog, resolveSectionArg, sectionDir, topicsPath, writeTopicCatalog } from './lib/cli-journal.ts';
import { getExtractor } from './providers/index.ts';

const dry = process.argv.includes('--dry');

// ── Proposal tool ─────────────────────────────────────────────────────────────

const reviewTool = (catalog: TopicCatalogT) => {
  return {
    name: 'propose_vocab_changes',
    description: 'Propose catalogue changes with reasoning citing the supplied statistics.',
    input_schema: z.toJSONSchema(proposalSchema(catalog.categories.map((c) => c.id))),
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

  // Apply ONLY additions. Removals, splits and merges stay markdown-only
  // suggestions: removing a topic needs human judgment, while an addition
  // is safe — a new topic never strips an existing lesson's tags.
  const applyResult = applyProposal(proposal, catalog, (next) => writeTopicCatalog(section.id, next, catalog));
  if (applyResult.additions > 0) {
    console.log(`✓ Applied ${applyResult.additions} addition(s) to ${topicsPath(section.id)}`);
  } else {
    console.log('No additions saved — _topics.json unchanged.');
  }
  const date = new Date().toISOString().slice(0, 10);
  const reviewsDir = join(sectionDir(section.id), '_topic-reviews');
  mkdirSync(reviewsDir, { recursive: true });
  const reportPath = join(reviewsDir, `${date}-${randomUUID()}.md`);
  writeFileSync(reportPath, renderProposal(proposal, stats, applyResult, date), { encoding: 'utf8', flag: 'wx' });
  console.log(`✓ Report written: ${reportPath}`);
  const failures = applyResult.outcomes.filter((outcome) => outcome.status === 'failed');
  if (failures.length) {
    for (const failure of failures) console.error(`Topic review error: ${failure.error}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  retainFailedCleanup(err);
  process.exitCode = 1;
});
