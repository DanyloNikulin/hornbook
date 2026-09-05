import { describe, expect, it, vi } from 'vitest';
import { applyProposal, normalizeProposal } from './vocab-proposal.ts';
import { renderProposal } from './vocab-review-report.ts';
import type { TopicCatalogT } from '../../src/lib/schema.ts';

const catalog: TopicCatalogT = { categories: [], topics: [] };
const addition = { id: 'food', categories: [], regex_patterns: ['food'], reasoning: '3 lessons' };
const stats = { computed_at: '2026-09-05', total_lessons: 10, vocab_size: 0 };

describe('topic proposal boundary and outcomes', () => {
  it.each([
    { splits: [{ from: 'food', into: 'meals', reasoning: '3 lessons' }] },
    { merges: [{ from: null, into: 'food', reasoning: '3 lessons' }] },
    { removals: [null] }, { concerns: [{ topic: 'food', issue: 12 }] },
    { additions: [{ ...addition, regex_patterns: [{}] }] },
    { splits: 'none' }, null, [],
  ])('rejects malformed nested results before applying or rendering: %j', (raw) => {
    expect(() => normalizeProposal(raw)).toThrow();
  });
  it('salvages omitted lists and the known category alias', () => {
    expect(normalizeProposal({ additions: [{ id: 'food', category: 'vocab', regex_patterns: ['food'], reasoning: '3 lessons' }] }).additions[0].categories).toEqual(['vocab']);
    expect(normalizeProposal({ summary: 'No changes' }).splits).toEqual([]);
  });
  it('reports individual application errors, successful saves and existing topics accurately', () => {
    const proposal = normalizeProposal({ additions: [addition, { ...addition, id: 'bad', regex_patterns: ['['] }, addition] });
    const save = vi.fn();
    const result = applyProposal(proposal, catalog, save);
    expect(result.additions).toBe(1);
    expect(result.outcomes.map((o) => o.status)).toEqual(['applied', 'failed', 'unchanged']);
    expect(save).toHaveBeenCalledOnce();
    const report = renderProposal(proposal, stats, result, '2026-09-05');
    expect(report).toContain('1 applied');
    expect(report).toContain('Not applied: Pattern for bad');
    expect(report).toContain('Already present; unchanged');
  });
  it('never reports failed disk writes as applied, including duplicate proposals', () => {
    const proposal = normalizeProposal({ additions: [addition, addition] });
    const result = applyProposal(proposal, catalog, () => { throw new Error('disk full'); });
    expect(result.additions).toBe(0);
    expect(result.outcomes.every((o) => o.status === 'failed')).toBe(true);
    const report = renderProposal(proposal, stats, result, '2026-09-05');
    expect(report).toContain('Catalogue save failed: disk full');
    expect(report).not.toContain('→ Applied');
  });
});
