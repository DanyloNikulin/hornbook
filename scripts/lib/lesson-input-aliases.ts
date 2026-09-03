// Field aliases that small local models use for the lesson tool.
//
// Observed with qwen2.5:7b via Ollama (2026-09-03): the conspect itself was
// sound, but Zod threw the whole lesson away because
//   • quiz items said `question` instead of `q`,
//   • a multiple-choice `answer` was the option text ("Buenos días") instead
//     of its index,
//   • flashcards had no `type`.
// Claude and GPT follow the tool schema to the letter; a 7B model follows it
// loosely. This module maps those loose shapes onto the schema — in place,
// reporting every change so it shows in the job log next to the
// double-encoding repairs (tool-input-repair.ts). Anything it cannot map is
// left alone for Zod to reject loudly, as before.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const QUIZ_TYPES = ['mc', 'fill', 'translate'] as const;
const CARD_TYPES = ['word', 'phrase', 'grammar'] as const;

/** Keys models use for the prompt of a quiz item, in order of preference. */
const QUESTION_ALIASES = ['question', 'prompt', 'text'] as const;
/** Keys models use for the correct choice of a multiple-choice item. */
const ANSWER_ALIASES = ['correct_answer', 'correct', 'answer_index', 'correct_index'] as const;

/** Card-type words models reach for, mapped to the schema's three. */
const CARD_TYPE_WORDS: Record<string, (typeof CARD_TYPES)[number]> = {
  word: 'word',
  vocab: 'word',
  vocabulary: 'word',
  noun: 'word',
  verb: 'word',
  adjective: 'word',
  phrase: 'phrase',
  phrases: 'phrase',
  expression: 'phrase',
  sentence: 'phrase',
  chunk: 'phrase',
  grammar: 'grammar',
  rule: 'grammar',
  pattern: 'grammar',
  conjugation: 'grammar',
};

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Map alias fields inside `quiz` and `flashcards` onto the Lesson schema,
 * mutating `input`. Returns one message per change.
 */
export function aliasLessonFields(input: Obj): string[] {
  const messages: string[] = [];
  const quiz = input['quiz'];
  if (Array.isArray(quiz)) {
    quiz.forEach((item, i) => {
      if (isObj(item)) aliasQuizItem(item, i, messages);
    });
  }
  const cards = input['flashcards'];
  if (Array.isArray(cards)) {
    cards.forEach((item, i) => {
      if (isObj(item)) aliasFlashcard(item, i, messages);
    });
  }
  return messages;
}

function aliasQuizItem(item: Obj, i: number, messages: string[]): void {
  const where = `quiz[${i}]`;

  if (!isText(item['q'])) {
    const key = QUESTION_ALIASES.find((k) => isText(item[k]));
    if (key) {
      item['q'] = item[key];
      delete item[key];
      messages.push(`${where}: '${key}' → 'q'`);
    }
  }

  if (!(QUIZ_TYPES as readonly unknown[]).includes(item['type'])) {
    const inferred = inferQuizType(item);
    if (inferred) {
      messages.push(`${where}: type ${JSON.stringify(item['type'] ?? null)} → '${inferred}' (from its fields)`);
      item['type'] = inferred;
    }
  }

  if (item['type'] === 'mc') aliasMcAnswer(item, where, messages);
  if (item['type'] === 'translate' && !isText(item['answer_target']) && isText(item['answer'])) {
    item['answer_target'] = item['answer'];
    delete item['answer'];
    messages.push(`${where}: 'answer' → 'answer_target'`);
  }
}

function inferQuizType(item: Obj): (typeof QUIZ_TYPES)[number] | undefined {
  if (Array.isArray(item['options'])) return 'mc';
  if (isText(item['answer_target'])) return 'translate';
  if (isText(item['answer'])) return 'fill';
  return undefined;
}

function aliasMcAnswer(item: Obj, where: string, messages: string[]): void {
  if (item['answer'] === undefined) {
    const key = ANSWER_ALIASES.find((k) => item[k] !== undefined);
    if (key) {
      item['answer'] = item[key];
      delete item[key];
      messages.push(`${where}: '${key}' → 'answer'`);
    }
  }
  const answer = item['answer'];
  const options = item['options'];
  if (typeof answer !== 'string' || !Array.isArray(options)) return;

  const index = mcAnswerIndex(answer, options);
  if (index === undefined) return;
  item['answer'] = index;
  messages.push(`${where}: answer ${JSON.stringify(answer)} → index ${index}`);
}

/**
 * Index of a multiple-choice answer given as text: a number written as a
 * string, the option itself, or (when no option is that letter) a letter
 * label like "B" / "b)".
 */
export function mcAnswerIndex(answer: string, options: readonly unknown[]): number | undefined {
  const a = answer.trim();
  if (/^\d+$/.test(a)) return Number(a);
  const texts = options.map((o) => (typeof o === 'string' ? norm(o) : ''));
  const exact = texts.indexOf(norm(a));
  if (exact !== -1) return exact;
  const letter = a.match(/^([A-Za-z])[).:]?$/);
  if (letter) {
    const idx = letter[1]!.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
    if (idx < options.length) return idx;
  }
  return undefined;
}

function aliasFlashcard(card: Obj, i: number, messages: string[]): void {
  const where = `flashcards[${i}]`;
  const type = card['type'];
  if ((CARD_TYPES as readonly unknown[]).includes(type)) return;

  const mapped = typeof type === 'string' ? CARD_TYPE_WORDS[norm(type)] : undefined;
  const chosen = mapped ?? defaultCardType(card['front']);
  messages.push(
    `${where}: type ${JSON.stringify(type ?? null)} → '${chosen}'${mapped ? '' : ' (from the front text)'}`,
  );
  card['type'] = chosen;
}

/** A single word is a word card; anything with a space is a phrase. */
export function defaultCardType(front: unknown): (typeof CARD_TYPES)[number] {
  return typeof front === 'string' && /\s/.test(front.trim()) ? 'phrase' : 'word';
}
