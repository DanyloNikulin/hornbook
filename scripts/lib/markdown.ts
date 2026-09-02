// Render a validated Lesson into the human-readable companion .md file that
// gets committed alongside lesson.json. The SPA doesn't read this file —
// it's purely for git diffs to be reviewable.

import type { LessonT } from '../../src/lib/schema.ts';

export function lessonToMarkdown(lesson: LessonT): string {
  const lines: string[] = [
    `# ${lesson.title}`,
    '',
    `**Date:** ${lesson.date}  ·  **Duration:** ${lesson.duration_min ?? '?'} min  ·  **Slug:** \`${lesson.slug}\``,
    '',
    '## Summary',
    '',
    lesson.summary,
    '',
    '## Article',
    '',
    lesson.article_md,
    '',
  ];

  if (lesson.vocabulary.length > 0) {
    lines.push('## Vocabulary', '', '| Target | Learner | Level | Example |', '|---|---|---|---|');
    for (const v of lesson.vocabulary) {
      const ex = v.example_target
        ? `${v.example_target}${v.example_learner ? ` — ${v.example_learner}` : ''}`
        : '';
      lines.push(`| ${v.target} | ${v.learner} | ${v.level ?? ''} | ${ex} |`);
    }
    lines.push('');
  }

  if (lesson.grammar.length > 0) {
    lines.push('## Grammar', '');
    for (const g of lesson.grammar) {
      lines.push(`### ${g.rule}`, '');
      for (const ex of g.examples) lines.push(`- ${ex}`);
      if (g.table) {
        lines.push('');
        const [header, ...rows] = g.table;
        lines.push(`| ${header.join(' | ')} |`);
        lines.push(`| ${header.map(() => '---').join(' | ')} |`);
        for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
      }
      lines.push('');
    }
  }

  if (lesson.quotes.length > 0) {
    lines.push('## Quotes', '');
    for (const q of lesson.quotes) {
      lines.push(`- _${q.ts} · ${q.speaker}_: "${q.text}"${q.gloss ? ` — ${q.gloss}` : ''}`);
    }
    lines.push('');
  }

  if (lesson.quiz.length > 0) {
    lines.push('## Quiz', '', `${lesson.quiz.length} question(s):`);
    for (const q of lesson.quiz) {
      lines.push(`- **${q.type}**: ${q.q}`);
    }
    lines.push('');
  }

  if (lesson.flashcards.length > 0) {
    lines.push('## Flashcards', '', `${lesson.flashcards.length} card(s).`, '');
  }

  if (lesson.slides.length > 0) {
    lines.push('## Slides', '');
    for (const s of lesson.slides) {
      lines.push(`### ${s.ts}`, '', s.text_md, '');
    }
  }

  return lines.join('\n');
}
