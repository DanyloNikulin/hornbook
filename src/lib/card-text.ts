// Derive the short answer expected by typing mode from an AI flashcard back.
// AI backs follow either "<answer> — <explanation>" (em/en dash with spaces)
// or "<answer>\n<example>". Markdown emphasis is visual only and therefore
// is removed from the value the learner has to type.
export function deriveExpectedFromBack(back: string): string {
  const firstLine = back.split('\n')[0];
  const beforeExplain = firstLine.split(/\s+[—–]\s+/)[0];
  return beforeExplain.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}
