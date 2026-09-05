import { z } from 'zod';
import type { TopicCatalogT } from '../../src/lib/schema.ts';
import { addTopic } from './vocab-apply.ts';

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export function proposalSchema(categories?: string[]) {
  return z.object({
    summary: z.string(),
    additions: z.array(z.object({
      id,
      categories: z.array(categories?.length ? z.enum(categories) : z.string()),
      regex_patterns: z.array(z.string().trim().min(1)).min(1),
      reasoning: z.string(),
    })),
    removals: z.array(z.object({ id, reasoning: z.string() })),
    splits: z.array(z.object({ from: id, into: z.array(id).min(2), reasoning: z.string() })),
    merges: z.array(z.object({ from: z.array(id).min(2), into: id, reasoning: z.string() })),
    concerns: z.array(z.object({ topic: z.string(), issue: z.string(), suggestion: z.string().optional() })),
  });
}
export type VocabProposal = z.infer<ReturnType<typeof proposalSchema>>;

/** Only omitted lists and the known singular category alias are salvaged. */
export function normalizeProposal(raw: unknown): VocabProposal {
  const object = z.record(z.string(), z.unknown()).parse(raw);
  const normalized: Record<string, unknown> = { summary: '(no summary)', additions: [], removals: [], splits: [], merges: [], concerns: [], ...object };
  if (Array.isArray(normalized['additions'])) {
    normalized['additions'] = normalized['additions'].map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const a = entry as Record<string, unknown>;
      const categories = a['categories'] ?? a['category'] ?? [];
      return { ...a, categories: typeof categories === 'string' ? [categories] : categories };
    });
  }
  return proposalSchema().parse(normalized);
}

type AdditionOutcome =
  | { status: 'applied' | 'unchanged' }
  | { status: 'failed'; error: string };
export interface ApplyResult {
  additions: number;
  outcomes: AdditionOutcome[];
}

export function applyProposal(
  proposal: VocabProposal,
  catalog: TopicCatalogT,
  save: (catalog: TopicCatalogT) => void,
): ApplyResult {
  let next = catalog;
  const staged = new Set<number>();
  const outcomes: AdditionOutcome[] = proposal.additions.map((a, index) => {
    try {
      const before = next;
      next = addTopic(next, { id: a.id, categories: a.categories, patterns: a.regex_patterns });
      if (next === before) {
        if (!catalog.topics.some((topic) => topic.id === a.id)) staged.add(index);
        return { status: 'unchanged' };
      }
      staged.add(index);
      return { status: 'applied' };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  });
  if (next !== catalog) {
    try {
      save(next);
    } catch (error) {
      for (const index of staged) {
        outcomes[index] = { status: 'failed', error: `Catalogue save failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }
  return { additions: outcomes.filter((o) => o.status === 'applied').length, outcomes };
}
