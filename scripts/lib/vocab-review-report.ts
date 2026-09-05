import { regexSource } from './vocab-apply.ts';
import type { ApplyResult, VocabProposal } from './vocab-proposal.ts';

// Render the proposal as a markdown report next to the catalogue it reviews.
export function renderProposal(
  p: VocabProposal,
  stats: { computed_at: string; total_lessons: number; vocab_size: number },
  result: ApplyResult,
  date: string,
): string {
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
    return lines.join('\n') + '\n';
  }

  // ── Additions ──
  if (p.additions.length > 0) {
    lines.push(`## Additions (${p.additions.length}) — ${result.additions} applied`);
    lines.push('');
    for (const [index, a] of p.additions.entries()) {
      const outcome = result.outcomes[index];
      lines.push(`### \`${a.id}\` — categories: ${a.categories.join(', ') || '(none)'}`);
      lines.push('');
      lines.push(`**Reasoning:** ${a.reasoning}`);
      lines.push('');
      lines.push(`**Proposed patterns:**`);
      lines.push('');
      lines.push('```');
      for (const re of a.regex_patterns) {
        lines.push(regexSource(re));
      }
      lines.push('```');
      lines.push('');
      lines.push(outcome?.status === 'applied'
        ? '→ Applied in `_topics.json`. To reject it, remove the entry there.'
        : outcome?.status === 'unchanged'
          ? '→ Already present; unchanged.'
          : `→ Not applied: ${outcome?.status === 'failed' ? outcome.error : 'no successful save recorded'}`);
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

- **Additions** show their individual save outcome above. Only entries marked applied were saved to \`_topics.json\`.
- **Removals / splits / merges** are **suggestions only — not applied**. Act on them by editing \`_topics.json\` if you agree.
- **Concerns** are advisory, no action proposed.

When the catalogue changes, the next \`backfill-topics --auto\` run detects it and adds the new tags to older lessons; it never removes a tag.`,
  );

  return lines.join('\n') + '\n';
}
