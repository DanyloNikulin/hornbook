// Pure, deterministic merger for cheat sheet patches.
//
// Why patches instead of a full rewrite: Claude used to return the entire
// categories[] array per build, which scales linearly with cheat sheet size
// and was already pushing max_tokens at 8 lessons. Now Claude returns only
// the deltas (add/update/remove sections per affected category) and this
// function applies them locally.
//
// Patch shape — chosen to be cheap for the model to produce:
//   {
//     category_id: 'grammar',
//     operation: 'add_sections' | 'update_sections' | 'remove_sections',
//     sections?:    CheatsheetSection[]   // for add_sections / update_sections
//     section_ids?: string[]              // for remove_sections
//   }
//
// Determinism guarantees:
//   - Categories appear in the order they were already present + any newly
//     introduced categories appended in the order their first patch arrived.
//   - Sections within a category preserve their existing order; add_sections
//     appends new ids; update_sections replaces in-place; remove_sections
//     filters by id.
//   - Idempotent: applying the same patch list twice yields the same result
//     as applying it once.

import type {
  CheatsheetCategoryT,
  CheatsheetSectionT,
  CheatsheetT,
} from '../../src/lib/schema.ts';
// Titles of the default catalogue's six categories, used when a patch
// introduces a category the cheat sheet does not have yet and the caller
// passed no titles of its own (the section's catalogue normally does).
export const DEFAULT_CATEGORY_TITLES: Record<string, string> = {
  grammar: 'Grammar',
  vocabulary: 'Vocabulary',
  pronunciation: 'Pronunciation',
  conversation: 'Conversation',
  reading: 'Reading',
  listening: 'Listening',
};

export type PatchOperation = 'add_sections' | 'update_sections' | 'remove_sections';

export interface CheatsheetPatch {
  category_id: string;
  operation: PatchOperation;
  // Present for add_sections / update_sections.
  sections?: CheatsheetSectionT[];
  // Present for remove_sections.
  section_ids?: string[];
}

function defaultTitleFor(id: string, titles: Record<string, string>): string {
  return titles[id] ?? DEFAULT_CATEGORY_TITLES[id] ?? id;
}

// Apply add_sections to a category: append sections whose id is not already
// present. Existing ids are silently skipped (idempotency — if the model
// re-emits the same add it's a no-op, not an error).
function applyAddSections(
  category: CheatsheetCategoryT,
  sections: CheatsheetSectionT[],
): CheatsheetCategoryT {
  const existingIds = new Set(category.sections.map((s) => s.id));
  const toAdd = sections.filter((s) => !existingIds.has(s.id));
  if (toAdd.length === 0) return category;
  return { ...category, sections: [...category.sections, ...toAdd] };
}

// Replace sections in place by id. Sections whose id is not currently in the
// category are appended (treating an update of a missing section as an add
// keeps the merger forgiving — Claude has sometimes mislabelled add as update
// when refining a previous draft).
function applyUpdateSections(
  category: CheatsheetCategoryT,
  sections: CheatsheetSectionT[],
): CheatsheetCategoryT {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const replaced = category.sections.map((s) => byId.get(s.id) ?? s);
  const replacedIds = new Set(replaced.map((s) => s.id));
  const newcomers = sections.filter((s) => !replacedIds.has(s.id));
  if (replaced === category.sections && newcomers.length === 0) return category;
  return { ...category, sections: [...replaced, ...newcomers] };
}

// Filter out sections by id. Missing ids are silently ignored (idempotent
// remove). Actual removals are logged loudly: combined with the SYSTEM_PROMPT
// asking Claude to ENRICH rather than rewrite, a stray remove_sections is
// more likely a hallucination than an intentional deletion, and we'd rather
// see it in CI logs than silently lose cheat-sheet content.
function applyRemoveSections(
  category: CheatsheetCategoryT,
  sectionIds: string[],
): CheatsheetCategoryT {
  if (sectionIds.length === 0) return category;
  const remove = new Set(sectionIds);
  const existingIds = new Set(category.sections.map((s) => s.id));
  for (const id of remove) {
    if (existingIds.has(id)) {
      console.warn(`patch: removing section "${id}" from category "${category.id}"`);
    }
  }
  const next = category.sections.filter((s) => !remove.has(s.id));
  if (next.length === category.sections.length) return category;
  return { ...category, sections: next };
}

// Locate or create a category by id. A new category takes the title the
// caller passed (the section's catalogue), else a default title, else the id.
function ensureCategory(
  categories: CheatsheetCategoryT[],
  id: string,
  titles: Record<string, string>,
): { idx: number; created: boolean } {
  const idx = categories.findIndex((c) => c.id === id);
  if (idx >= 0) return { idx, created: false };
  categories.push({ id, title: defaultTitleFor(id, titles), sections: [] });
  return { idx: categories.length - 1, created: true };
}

// Apply a list of patches to a cheat sheet, returning a new cheat sheet
// object. Pure: does not mutate the input.
export function applyPatches(
  current: CheatsheetT,
  patches: readonly CheatsheetPatch[],
  titles: Record<string, string> = {},
): CheatsheetT {
  // Work on a shallow copy of the categories array — we may push new
  // categories onto it. Each category is replaced wholesale when patched,
  // never mutated in place.
  const categories: CheatsheetCategoryT[] = current.categories.map((c) => ({ ...c }));

  for (const patch of patches) {
    const { idx } = ensureCategory(categories, patch.category_id, titles);
    const cat = categories[idx];
    if (!cat) continue; // unreachable — ensureCategory always returns a valid idx

    switch (patch.operation) {
      case 'add_sections':
        categories[idx] = applyAddSections(cat, patch.sections ?? []);
        break;
      case 'update_sections':
        categories[idx] = applyUpdateSections(cat, patch.sections ?? []);
        break;
      case 'remove_sections':
        categories[idx] = applyRemoveSections(cat, patch.section_ids ?? []);
        break;
    }
  }

  return { ...current, categories };
}
