// Run the extract model and validate its lesson, with one repair round.
//
// Claude and GPT follow the tool schema; a small local model mostly does, and
// where it does not (a quiz item without its options, a flashcard without a
// type) the aliases below fix the common shapes. What they cannot fix is
// sent back to the model once, as a list of Zod issues next to its previous
// output, with the instruction to return the complete lesson corrected.
// One round: a second failure is reported like a first one used to be.
//
// Every model answer and every set of validation errors is written to the
// job's logs dir (tool-input.json, tool-input-2.json, validation-errors*.json)
// so a failed run can be read afterwards.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodError } from 'zod';
import { Lesson, type LessonT } from '../../src/lib/schema.ts';
import { coerceStringifiedFields } from './tool-input-repair.ts';
import { aliasLessonFields } from './lesson-input-aliases.ts';
import type { ExtractRequest, Extractor } from '../providers/types.ts';

export interface ValidatedExtract {
  lesson: LessonT;
  /** The (alias-repaired) tool input the lesson was parsed from. */
  toolInput: Record<string, unknown>;
  attempts: number;
}

type Log = Pick<Console, 'warn' | 'log'>;

const MAX_ATTEMPTS = 2;
const MAX_ISSUES_SENT = 40;

export async function extractValidated(
  extractor: Extractor,
  req: ExtractRequest,
  logsDir: string,
  log: Log = console,
): Promise<ValidatedExtract> {
  let raw = await extractor.extract(req);
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    writeFileSync(join(logsDir, `tool-input${suffix}.json`), JSON.stringify(raw, null, 2), 'utf8');

    const toolInput = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    for (const msg of coerceStringifiedFields(toolInput)) log.warn(`⚠ Tool input coercion: ${msg}`);
    for (const msg of aliasLessonFields(toolInput)) log.warn(`⚠ Tool input alias: ${msg}`);

    const result = Lesson.safeParse(toolInput);
    if (result.success) {
      const hollow = hollowIssues(result.data);
      if (hollow.length === 0) return { lesson: result.data, toolInput, attempts: attempt };
      if (attempt >= MAX_ATTEMPTS) {
        log.warn('⚠ Lesson still has no vocabulary or quiz after a repair round; saving it as it is. A larger model may do better on this recording.');
        return { lesson: result.data, toolInput, attempts: attempt };
      }
      writeFileSync(join(logsDir, `validation-errors${suffix}.json`), JSON.stringify({ hollow }, null, 2), 'utf8');
      log.warn(`⚠ Lesson has no vocabulary or quiz (everything went into the article?); asking ${extractor.driver} to fill them once.`);
      raw = await extractor.extract({
        ...req,
        userParts: [...req.userParts, { type: 'text', text: repairMessage(toolInput, hollow) }],
      });
      continue;
    }

    const errorsPath = join(logsDir, `validation-errors${suffix}.json`);
    writeFileSync(errorsPath, JSON.stringify(result.error.format(), null, 2), 'utf8');
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`Lesson JSON failed Zod validation after a repair round. See ${errorsPath}.`);
    }

    const issues = formatIssues(result.error);
    log.warn(`⚠ Lesson failed validation (${result.error.issues.length} issue(s)); asking ${extractor.driver} to repair it once.`);
    raw = await extractor.extract({
      ...req,
      userParts: [...req.userParts, { type: 'text', text: repairMessage(toolInput, issues) }],
    });
  }
}

/**
 * A schema-valid lesson with neither vocabulary nor quiz is hollow: seen
 * from gemma3:4b with slide images attached, which wrote the whole lesson,
 * vocabulary table included, into article_md and left the fields the app
 * studies from empty. Phrased like Zod issues so the same repair round
 * asks for them.
 */
export function hollowIssues(lesson: LessonT): string[] {
  if (lesson.vocabulary.length > 0 || lesson.quiz.length > 0) return [];
  const issues = [
    'vocabulary: empty — list every word and phrase the lesson taught, each with target, learner, level, example_target and example_learner',
    'quiz: empty — write 3 to 6 questions (mc, fill, translate) about this lesson',
  ];
  if (lesson.flashcards.length === 0) issues.push('flashcards: empty — at least one card per vocabulary item');
  if (lesson.grammar.length === 0) issues.push('grammar: empty — one rule per pattern the teacher explained, if any');
  return issues;
}

/** "quiz.0.options: Invalid input: expected array, received undefined" */
export function formatIssues(error: ZodError): string[] {
  return error.issues
    .slice(0, MAX_ISSUES_SENT)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
}

export function repairMessage(previous: Record<string, unknown>, issues: readonly string[]): string {
  return [
    'Your previous save_lesson call was rejected. Fix ONLY the problems listed below and call the tool again with the COMPLETE lesson, keeping everything else exactly as it was.',
    '',
    'Problems (field path: what is wrong):',
    ...issues.map((i) => `- ${i}`),
    '',
    'Reminder of the shapes: a quiz item of type "mc" needs "options" (2-6 strings) and "answer" (zero-based index into options); type "fill" needs "answer" (the expected text); type "translate" needs "answer_target". A flashcard needs "type": "word", "phrase" or "grammar".',
    'An empty array is a problem when the transcript or the slides have the material: put it in the structured field (and keep the article).',
    '',
    'Your previous output:',
    JSON.stringify(previous),
  ].join('\n');
}
