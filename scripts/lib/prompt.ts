import { TOPIC_VOCAB, type TopicT } from '../../src/lib/schema.ts';
import { learnerLanguageName, targetLanguageName } from './config.ts';

export function buildSystemPrompt(): string {
  const target = targetLanguageName();
  const learner = learnerLanguageName();
  const topicList = TOPIC_VOCAB.join(', ');
  return `You are an expert assistant who builds structured study materials from one-on-one language lessons.

CONTEXT
You receive the transcript of a recorded 1-on-1 ${target} lesson (about 30–90 minutes).
The teacher may explain in ${learner} (or another shared language) and give examples in ${target}.
You may also receive deduplicated screenshots from screen-share — tables, example sentences, exercise prompts.

PRIVACY RULES (HARD CONSTRAINTS — VIOLATIONS WILL BE THROWN AWAY)
1. Replace personal first names of real people with placeholders: [teacher], [student], [friend], [colleague].
2. Anonymize anecdotes — keep the LANGUAGE POINT but generalize identity.
3. DROP ENTIRELY: scheduling next lessons, payment, off-topic personal life, medical or family privacy, holiday plans tied to specific people.
4. KEEP: grammar explanations, vocabulary, conjugation patterns, anonymized example sentences, teacher quotes (label speaker as "teacher", never include their name), slide content.
5. When in doubt → DROP.

WORKFLOW
You MUST call the \`save_lesson\` tool exactly once with the full lesson data. Do not return prose.

MENTAL MODEL
This is a STUDY REFERENCE the student will read days/weeks later — not a session recap.
Synthesize the content by topic. Reorganize, deduplicate, condense.

ARTICLE_MD STRUCTURE (write in ${learner})
- Organize by TOPIC, not by lesson chronology.
- Skip warm-up, small talk, scheduling, off-topic chatter.
- Use this skeleton (omit empty sections):

  ## Takeaway
  1-2 sentences — the main thing to walk away with.

  ## Rules
  For each rule (## or ###):
    - rule statement (bold)
    - WHY/WHEN it applies
    - 2-4 ${target} examples with ${learner} gloss in parentheses

  ## Useful chunks
  (Optional) Larger phrases / mini-dialogues the student practiced.

300-700 words target. Quality > word count.

CONTENT GUIDELINES
- title: 3-7 word descriptive topic (in ${target} or hybrid).
- slug: kebab-case ASCII, lowercase only.
- summary: 2-3 sentences in ${learner}, what was covered.
- vocabulary: ${target} words/phrases from this lesson.
  - DEDUPLICATE: each ${target} lemma appears AT MOST ONCE.
  - SKIP filler greetings unless genuinely worth learning.
  - \`level\` is the CEFR rating ("A1".."C2") or null.
  - REQUIRED: every entry MUST include \`example_target\` and \`example_learner\`.
- grammar: one-sentence rule, 3-6 ${target} examples. Slide tables go in \`table\` as a 2D string array (first row = header).
- quotes: 2-5 memorable teacher lines in ${target}. \`text\` is the original, \`gloss\` is optional ${learner}. \`ts\` is a SINGLE timestamp like "12:43".
- quiz: 5-10 questions. Types: "mc", "fill", "translate" (${learner} → ${target}, auto_check=false).
- flashcards: 5-15 cards covering vocab AND grammar patterns.
- slides: unique slides that contributed information.
- duration_min: integer minutes from the transcript's last timestamp.
- date: use the date_hint provided.
- id: same as date-slug.
- related: slugs of EXISTING lessons covering the SAME core topic. Empty array when in doubt.
- topics: tags from this vocabulary only: ${topicList}
- suggested_new_topics: kebab-case IDs for concepts missing from the topic list. Empty array is normal.

If the lesson content is too sparse or unclear, still call the tool with empty arrays rather than fabricating content.`;
}

const lvl = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export function buildLessonTool(): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  const target = targetLanguageName();
  const learner = learnerLanguageName();
  return {
    name: 'save_lesson',
    description: 'Save the structured lesson extracted from the transcript and slides. Call this exactly once.',
    input_schema: {
      type: 'object',
      required: [
        'id',
        'date',
        'slug',
        'title',
        'summary',
        'article_md',
        'vocabulary',
        'grammar',
        'quotes',
        'quiz',
        'flashcards',
        'slides',
        'related',
        'topics',
        'suggested_new_topics',
      ],
      properties: {
        id: { type: 'string' },
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
        title: { type: 'string' },
        summary: { type: 'string', description: `2-3 sentences in ${learner}.` },
        article_md: { type: 'string', description: `Study article in ${learner}.` },
        duration_min: { type: 'integer', minimum: 1 },
        vocabulary: {
          type: 'array',
          items: {
            type: 'object',
            required: ['target', 'learner', 'example_target', 'example_learner'],
            properties: {
              target: { type: 'string', description: `${target} word or phrase.` },
              learner: { type: 'string', description: `${learner} translation.` },
              level: { type: ['string', 'null'], enum: [...lvl, null] },
              example_target: { type: 'string' },
              example_learner: { type: 'string' },
            },
          },
        },
        grammar: {
          type: 'array',
          items: {
            type: 'object',
            required: ['rule', 'examples'],
            properties: {
              rule: { type: 'string' },
              examples: { type: 'array', items: { type: 'string' } },
              table: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
        quotes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['speaker', 'text', 'ts'],
            properties: {
              speaker: { type: 'string', enum: ['teacher', 'student'] },
              text: { type: 'string', description: `Original line in ${target}.` },
              gloss: { type: 'string', description: `Optional ${learner} gloss.` },
              ts: { type: 'string' },
            },
          },
        },
        // Spelled out so a schema-enforcing endpoint (Ollama's structured
        // output) holds a small model to the field names Zod expects.
        // One shape per quiz type, mirroring the Zod union: a small model
        // given a single loose object schema fills in only the fields marked
        // required and folds the choices into the question text.
        quiz: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                required: ['type', 'q', 'options', 'answer'],
                properties: {
                  type: { type: 'string', enum: ['mc'] },
                  q: { type: 'string', description: 'The question, without the choices.' },
                  options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
                  answer: { type: 'integer', minimum: 0, description: 'Zero-based index into options.' },
                  explanation: { type: 'string' },
                },
              },
              {
                type: 'object',
                required: ['type', 'q', 'answer'],
                properties: {
                  type: { type: 'string', enum: ['fill'] },
                  q: { type: 'string', description: 'Sentence with a blank.' },
                  answer: { type: 'string', description: 'The expected text.' },
                  alternatives: { type: 'array', items: { type: 'string' } },
                  case_sensitive: { type: 'boolean' },
                },
              },
              {
                type: 'object',
                required: ['type', 'q', 'answer_target'],
                properties: {
                  type: { type: 'string', enum: ['translate'] },
                  q: { type: 'string', description: `Text in ${learner} to translate.` },
                  answer_target: { type: 'string', description: `The expected ${target}.` },
                  alternatives: { type: 'array', items: { type: 'string' } },
                  auto_check: { type: 'boolean' },
                },
              },
            ],
          },
        },
        flashcards: {
          type: 'array',
          items: {
            type: 'object',
            required: ['front', 'back', 'type'],
            properties: {
              front: { type: 'string', description: `${target} side.` },
              back: { type: 'string', description: `${learner} side.` },
              type: { type: 'string', enum: ['word', 'phrase', 'grammar'] },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            required: ['ts', 'text_md'],
            properties: {
              ts: { type: 'string', description: 'HH:MM:SS of the frame.' },
              text_md: { type: 'string' },
              extracted_table: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
        related: { type: 'array', items: { type: 'string' } },
        topics: {
          type: 'array',
          items: { type: 'string', enum: [...TOPIC_VOCAB] },
        },
        suggested_new_topics: { type: 'array', items: { type: 'string' } },
      },
    },
  };
}

export interface ExistingLessonRef {
  slug: string;
  date: string;
  title: string;
  summary: string;
  topics: readonly TopicT[];
}

export function userMessageForLesson(opts: {
  transcript: string;
  dateHint: string;
  framesManifest: { ts: string; file: string }[];
  existingLessons: ExistingLessonRef[];
  preliminaryTopics: readonly TopicT[];
}): string {
  const target = targetLanguageName();
  const learner = learnerLanguageName();
  const frames =
    opts.framesManifest.length === 0
      ? '(no slides)'
      : opts.framesManifest.map((f, i) => `${i + 1}. ${f.ts} ${f.file}`).join('\n');
  const existing =
    opts.existingLessons.length === 0
      ? '(none)'
      : opts.existingLessons
          .map((l) => `- ${l.slug} (${l.date}) ${l.title} — ${l.summary} [${l.topics.join(', ')}]`)
          .join('\n');
  return `DATE_HINT: ${opts.dateHint}
TARGET LANGUAGE: ${target}
LEARNER LANGUAGE: ${learner}
PRELIMINARY TOPICS: ${opts.preliminaryTopics.join(', ') || '(none)'}
EXISTING LESSONS:
${existing}

SLIDE FRAMES (in order, attached as images if present):
${frames}

TRANSCRIPT:
${opts.transcript}`;
}
