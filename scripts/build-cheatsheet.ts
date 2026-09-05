#!/usr/bin/env node
// Reads all lessons/*.json, finds ones not yet in cheatsheet.json, computes
// which cheat sheet categories each new lesson's topics can affect, sends
// the pair's extract model only those affected categories + the new grammar,
// and asks for a list of patches (add/update/remove sections per category) — not a full
// rewrite. Patches are applied locally by applyPatches() and the result is
// written to cheatsheet.json (repo root). The Angular SPA ships that root
// file directly via the assets glob (see angular.json); no _data copy.
//
// Usage:
//   tsx scripts/build-cheatsheet.ts            # process new lessons only
//   tsx scripts/build-cheatsheet.ts --force    # ignore processed_lessons,
//                                              # rebuild everything from scratch
//   tsx scripts/build-cheatsheet.ts --dry-run  # build the payload, log its
//                                              # size, do NOT call the model
//
// Runs on the section's extract driver (Ollama, Anthropic or OpenAI), the
// same one process.ts uses, so a whisper.cpp + Ollama journal needs no key.
//
// Why patches instead of full rewrite: previous flow asked Claude to return
// the COMPLETE categories[] in max_tokens: 8000. Output scaled with cheat
// sheet size, hitting truncation around 30-40 lessons. With patches, output
// stays bounded regardless of cheat sheet size.

import { retainFailedCleanup } from './lib/cli-failure.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  Cheatsheet,
  type CheatsheetT,
  type CheatsheetCategoryT,
  type GrammarRuleT,
  type TopicCatalogT,
  type TopicT,
} from '../src/lib/schema.ts';
import {
  categoryIds,
  categoryTitle,
  type CheatsheetCategoryId,
  computeAffectedCategories,
} from './lib/topic-to-category.ts';
import { applyPatches, type CheatsheetPatch, type PatchOperation } from './lib/cheatsheet-patch.ts';
import { learnerLanguageName, targetLanguageName } from './lib/config.ts';
import {
  cheatsheetPath,
  currentSection,
  readSectionLessons,
  readTopicCatalog,
  resolveSectionArg,
} from './lib/cli-journal.ts';
import { getExtractor } from './providers/index.ts';

// The section is selected once in main() (--section); every path below
// derives from it.
const CHEATSHEET_PATH = (): string => cheatsheetPath(currentSection().id);

// ── Tool definition (JSON schema: a forced tool call on Anthropic, a
// structured-output schema on OpenAI and Ollama) ─────────────────────────
//
// apply_cheatsheet_patches: model returns deltas per affected category,
// NOT a full categories[] array. Local applyPatches() merges them into the
// current cheat sheet.

const patchesTool = (catalog: TopicCatalogT) => ({
  name: 'apply_cheatsheet_patches',
  description:
    'Return a list of patches to apply to the cheat sheet. Each patch targets ONE category by id and contains add_sections / update_sections / remove_sections. DO NOT return the entire cheat sheet — only the deltas. If a section already covers a new lesson\'s topic, enrich it via update_sections (keep id, add to main_table / exception_tables / notes / source_lessons); only use add_sections for genuinely new sections. The merger is idempotent — repeating an unchanged section is fine but wasteful.',
  input_schema: {
    type: 'object',
    required: ['patches'],
    properties: {
      patches: {
        type: 'array',
        items: {
          type: 'object',
          required: ['category_id', 'operation'],
          properties: {
            category_id: {
              type: 'string',
              enum: categoryIds(catalog),
              description:
                'Target category id from the CATEGORIES list. The user message tells you which categories are in scope for this build.',
            },
            operation: {
              type: 'string',
              enum: ['add_sections', 'update_sections', 'remove_sections'],
              description:
                'add_sections — append brand-new sections. update_sections — replace existing sections in place by id (use this to enrich). remove_sections — drop sections by id (rare; only if a section is genuinely obsolete).',
            },
            sections: {
              type: 'array',
              description:
                'For add_sections / update_sections: the section objects. Each must include id, title, and source_lessons.',
              items: {
                type: 'object',
                required: ['id', 'title', 'source_lessons'],
                properties: {
                  id: {
                    type: 'string',
                    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
                    description:
                      'Unique section id within the category, e.g. "presente-are", "passato-prossimo".',
                  },
                  title: {
                    type: 'string',
                    description: 'Section heading, e.g. "Present tense — -ar verbs".',
                  },
                  main_table: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'string' } },
                    description:
                      '2D table. First row = headers. Use for conjugation / reference tables.',
                  },
                  exception_tables: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['title', 'table'],
                      properties: {
                        title: { type: 'string' },
                        table: {
                          type: 'array',
                          items: { type: 'array', items: { type: 'string' } },
                        },
                      },
                    },
                    description:
                      'Exception or special-case tables (e.g. irregular verbs).',
                  },
                  notes: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Short bullet-point rules or reminders in the learner language.',
                  },
                  source_lessons: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'Lesson slugs this section was built from. When updating, INCLUDE prior slugs you saw in the input AND add the new one.',
                  },
                },
              },
            },
            section_ids: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For remove_sections only: ids of sections to drop. Ignored for other operations.',
            },
          },
        },
      },
    },
  },
});

const systemPrompt = (catalog: TopicCatalogT): string => {
const TARGET = targetLanguageName();
const LEARNER = learnerLanguageName();
return `You are maintaining a grammar cheat sheet for a language student. You receive (1) the current state of the categories that the new lessons can affect and (2) the new lessons' grammar + topics. You return a LIST OF PATCHES describing how to update those categories.

CATEGORIES (the user message tells you which subset is in scope):
${catalog.categories.map((c) => `- id: "${c.id}", title: "${c.title}"`).join('\n') || '- (none in the catalogue yet: use the ids named in the user message)'}

PATCH OPERATIONS:
- add_sections — append brand-new sections to a category.
- update_sections — replace an existing section by id. USE THIS TO ENRICH (add to main_table, append notes, extend source_lessons). When you update, include the FULL new state of the section (the merger replaces wholesale).
- remove_sections — drop sections by id. Rare. Only use if a section is genuinely obsolete.

RULES:
1. NEVER duplicate sections. If a section already covers a topic, ENRICH it via update_sections.
2. Each section must have a concise main_table (the core reference — conjugation table, article table, etc.).
3. exception_tables hold irregular forms, special cases.
4. notes are short ${LEARNER} bullet points — the "remember this" reminders.
5. Tables stay compact: 2–4 example verbs in conjugation tables, not exhaustive lists.
6. Return ONLY patches for categories that actually change. If a lesson adds nothing to a category, do not emit a patch for it.
7. Titles in ${LEARNER}; table content in ${TARGET} (${LEARNER} glosses in parentheses where helpful).
8. When updating an existing section, keep its id and merge its source_lessons with the new lesson slug — do not drop prior slugs.`;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function loadCheatsheet(): CheatsheetT {
  if (!existsSync(CHEATSHEET_PATH())) {
    return { processed_lessons: [], categories: [] };
  }
  const raw = JSON.parse(readFileSync(CHEATSHEET_PATH(), 'utf8'));
  const result = Cheatsheet.safeParse(raw);
  if (!result.success) {
    console.warn('⚠ cheatsheet.json failed validation — starting fresh.');
    return { processed_lessons: [], categories: [] };
  }
  return result.data;
}

interface NewLessonInput {
  slug: string;
  title: string;
  date: string;
  grammar: GrammarRuleT[];
  topics: TopicT[];
  affectedCategories: readonly CheatsheetCategoryId[];
}

function loadNewLessons(processedSlugs: Set<string>, catalog: TopicCatalogT): NewLessonInput[] {
  return readSectionLessons(currentSection().id).flatMap(({ lesson }) => {
    if (processedSlugs.has(lesson.slug)) return [];
    const affected = computeAffectedCategories(lesson.topics, catalog);
    // Skip lessons that can't affect the cheat sheet at all. A lesson with
    // no topical hooks AND no grammar rules wouldn't change anything even
    // if we asked the model.
    if (affected.length === 0 && lesson.grammar.length === 0) return [];
    return [
      {
        slug: lesson.slug,
        title: lesson.title,
        date: lesson.date,
        grammar: lesson.grammar,
        topics: lesson.topics,
        affectedCategories: affected,
      },
    ];
  });
}

// Compute the union of categories the whole batch affects. Lessons with no
// affected categories but non-empty grammar fall back to the catalogue's
// first category so the model still has somewhere to put them.
function computeBatchScope(
  lessons: readonly NewLessonInput[],
  catalog: TopicCatalogT,
): readonly CheatsheetCategoryId[] {
  const set = new Set<CheatsheetCategoryId>();
  const fallback = categoryIds(catalog)[0];
  for (const l of lessons) {
    for (const c of l.affectedCategories) set.add(c);
    // Grammar with no mapped topics still needs a home.
    if (l.affectedCategories.length === 0 && l.grammar.length > 0 && fallback) set.add(fallback);
  }
  return categoryIds(catalog).filter((id) => set.has(id));
}

// Build the in-scope slice of the current cheat sheet — only the categories
// the batch will touch. Categories that don't yet exist on the cheat sheet
// are emitted as empty placeholders so the model can add_sections into them.
function pickInScopeCategories(
  current: CheatsheetT,
  scope: readonly CheatsheetCategoryId[],
  catalog: TopicCatalogT,
): CheatsheetCategoryT[] {
  return scope.map((id) => {
    const existing = current.categories.find((c) => c.id === id);
    if (existing) return existing;
    return { id, title: categoryTitle(catalog, id), sections: [] };
  });
}

function buildUserMessage(
  inScope: readonly CheatsheetCategoryT[],
  newLessons: readonly NewLessonInput[],
): string {
  const scopeBlock =
    inScope.length > 0
      ? `IN-SCOPE CATEGORIES (current state — enrich these, do not touch others):\n${JSON.stringify(inScope, null, 2)}`
      : 'IN-SCOPE CATEGORIES: (none — this batch creates new categories from scratch)';

  const newBlock = newLessons
    .map(
      (l) =>
        `\nLESSON: ${l.slug} (${l.date}) — ${l.title}\n` +
        `TOPICS: ${l.topics.join(', ') || '(none)'}\n` +
        `AFFECTS CATEGORIES: ${l.affectedCategories.join(', ') || '(none — falls back to grammar)'}\n` +
        `GRAMMAR RULES:\n${JSON.stringify(l.grammar, null, 2)}`,
    )
    .join('\n\n---');

  return (
    `Merge the following new lessons into the cheat sheet by calling ` +
    `apply_cheatsheet_patches. Only emit patches for categories listed in ` +
    `IN-SCOPE — do not invent patches for other categories.\n\n` +
    scopeBlock +
    `\n\nNEW LESSONS TO MERGE:\n` +
    newBlock
  );
}

// Coerce the tool_use input into the local CheatsheetPatch shape. We don't
// trust the model blindly — bad operations / missing fields throw with a
// clear message so the run fails loud rather than producing a half-merged
// cheat sheet.
function parsePatchesFromToolInput(input: unknown): CheatsheetPatch[] {
  if (!input || typeof input !== 'object' || !('patches' in input)) {
    throw new Error('apply_cheatsheet_patches: missing "patches" key in tool input');
  }
  const raw = (input as { patches: unknown }).patches;
  if (!Array.isArray(raw)) {
    throw new Error('apply_cheatsheet_patches: "patches" must be an array');
  }
  return raw.map((p, i) => {
    if (!p || typeof p !== 'object') {
      throw new Error(`patches[${i}]: not an object`);
    }
    const obj = p as Record<string, unknown>;
    const category_id = obj['category_id'];
    const operation = obj['operation'];
    if (typeof category_id !== 'string') {
      throw new Error(`patches[${i}]: category_id must be a string`);
    }
    if (
      operation !== 'add_sections' &&
      operation !== 'update_sections' &&
      operation !== 'remove_sections'
    ) {
      throw new Error(`patches[${i}]: invalid operation ${JSON.stringify(operation)}`);
    }
    const sections = obj['sections'];
    const section_ids = obj['section_ids'];
    const out: CheatsheetPatch = { category_id, operation: operation as PatchOperation };
    if (sections !== undefined) {
      if (!Array.isArray(sections)) {
        throw new Error(`patches[${i}]: sections must be an array`);
      }
      // Trust the JSON schema enforcement on the model side; Zod validation
      // of the final cheatsheet will catch anything that slipped through.
      out.sections = sections as CheatsheetPatch['sections'];
    }
    if (section_ids !== undefined) {
      if (!Array.isArray(section_ids) || section_ids.some((s) => typeof s !== 'string')) {
        throw new Error(`patches[${i}]: section_ids must be an array of strings`);
      }
      out.section_ids = section_ids as string[];
    }
    return out;
  });
}

function summarisePatches(patches: readonly CheatsheetPatch[]): string {
  if (patches.length === 0) return '(no patches)';
  return patches
    .map((p) => {
      const count =
        p.operation === 'remove_sections'
          ? (p.section_ids?.length ?? 0)
          : (p.sections?.length ?? 0);
      return `${p.category_id}.${p.operation}(${count})`;
    })
    .join(', ');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const section = resolveSectionArg(process.argv);
  console.log(`Section: ${section.id}`);
  const catalog = readTopicCatalog(section.id);
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');

  const current = force ? { processed_lessons: [], categories: [] } : loadCheatsheet();
  if (force) console.log('--force: rebuilding cheatsheet from scratch');

  const processedSlugs = new Set(current.processed_lessons);
  const newLessons = loadNewLessons(processedSlugs, catalog);

  if (newLessons.length === 0) {
    console.log('✓ Cheat sheet is up to date — no new lessons to process.');
    return;
  }

  console.log(
    `Processing ${newLessons.length} new lesson(s): ${newLessons.map((l) => l.slug).join(', ')}`,
  );
  for (const l of newLessons) {
    console.log(
      `  ${l.slug}: topics=[${l.topics.join(', ') || '∅'}] → categories=[${l.affectedCategories.join(', ') || '∅'}]`,
    );
  }

  const scope = computeBatchScope(newLessons, catalog);
  const inScope = pickInScopeCategories(current, scope, catalog);
  const userMessage = buildUserMessage(inScope, newLessons);

  console.log(`In-scope categories: [${scope.join(', ') || '∅'}]`);
  console.log(`User message size: ${userMessage.length} chars (~${Math.ceil(userMessage.length / 4)} tokens est.)`);

  if (dryRun) {
    console.log('--dry-run: not calling the model.');
    return;
  }

  const extractor = getExtractor();
  const tool = patchesTool(catalog);
  console.log(`Writing patches via ${extractor.driver}...`);
  const toolInput = await extractor.extract({
    system: systemPrompt(catalog),
    userParts: [{ type: 'text', text: userMessage }],
    jsonSchema: tool.input_schema,
    toolName: tool.name,
    toolDescription: tool.description,
  });

  const patches = parsePatchesFromToolInput(toolInput);
  console.log(`Patches received: ${summarisePatches(patches)}`);

  const merged = applyPatches(
    current,
    patches,
    Object.fromEntries(catalog.categories.map((c) => [c.id, c.title])),
  );
  const updatedCheatsheet: CheatsheetT = {
    ...merged,
    processed_lessons: [...processedSlugs, ...newLessons.map((l) => l.slug)],
    updated_at: new Date().toISOString().slice(0, 10),
  };

  const validation = Cheatsheet.safeParse(updatedCheatsheet);
  if (!validation.success) {
    console.error('Validation errors:', JSON.stringify(validation.error.format(), null, 2));
    throw new Error('Updated cheatsheet failed Zod validation.');
  }

  writeFileSync(CHEATSHEET_PATH(), JSON.stringify(validation.data, null, 2) + '\n', 'utf8');
  console.log(`✓ ${section.id}/_cheatsheet.json updated (${validation.data.categories.length} categories)`);
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error('\n✘', e.message);
  if (e.stack) console.error(e.stack);
  if (!retainFailedCleanup(err)) process.exit(1);
});
