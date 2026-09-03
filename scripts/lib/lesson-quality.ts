// Post-parse cleanup for small local extract models.
//
// Observed with qwen2.5:7b via Ollama on a 10-minute German A1 video and a
// 15-minute Norwegian A2 video (whisper-cli + ggml-small, 2026-09-03): the
// lesson JSON was schema-valid, but
//   • vocabulary was empty while the same words sat on flashcards,
//   • quotes were a speaker label ("Teacher"), an empty markdown leftover,
//     or an English line that never appeared in the transcript.
// Claude and GPT follow the quote/vocab rules; a 7B model often does not.
// This module salvages those shapes in place, before Zod, so a free-stack
// run still yields something the app can study from. Anything it cannot
// map is left for Zod / hollowIssues.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Fold for "does this quote appear in the transcript?" — case, marks, punctuation out. */
export function foldForMatch(value: string): string {
  return value
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Speaker label or markdown leftover, not a sentence the teacher said. */
export function isJunkQuoteText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(?:\*{1,2})?(?:\[)?(?:teacher|student|tutor|text)(?:\])?\s*:?\s*(?:\*{1,2})?\s*$/i.test(
    trimmed,
  );
}

/** Drop `[00:05] teacher:` chrome so a quote stitched across two lines still matches. */
function linesForMatch(transcript: string): string {
  return transcript
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?\]?\s*/, '')
        .replace(/^(?:teacher|student|tutor)\s*:\s*/i, ''),
    )
    .join(' ');
}

export function quoteAppearsInTranscript(text: string, transcript: string): boolean {
  const needle = foldForMatch(text);
  if (!needle) return false;
  return foldForMatch(linesForMatch(transcript)).includes(needle);
}

/** The extract user message puts the recording after `TRANSCRIPT:`; ignore the rest. */
export function transcriptFromUserMessage(userText: string): string {
  const marker = 'TRANSCRIPT:';
  const i = userText.lastIndexOf(marker);
  return i === -1 ? userText : userText.slice(i + marker.length);
}

/**
 * Fill empty vocabulary from flashcards and drop quotes that are empty,
 * speaker labels, or invented (not in `transcript`). Mutates `input`.
 * `transcript` is the recording body (not a later repair message).
 */
export function salvageLessonFields(input: Obj, transcript: string): string[] {
  const messages: string[] = [];
  salvageVocabulary(input, messages);
  salvageQuotes(input, transcript, messages);
  return messages;
}

function salvageVocabulary(input: Obj, messages: string[]): void {
  const vocab = input['vocabulary'];
  if (Array.isArray(vocab) && vocab.length > 0) return;
  if (vocab !== undefined && !Array.isArray(vocab)) return;

  const cards = input['flashcards'];
  if (!Array.isArray(cards)) return;

  const seen = new Set<string>();
  const filled: Obj[] = [];
  for (const card of cards) {
    if (!isObj(card) || !isText(card['front']) || !isText(card['back'])) continue;
    const type = typeof card['type'] === 'string' ? card['type'].trim().toLowerCase() : '';
    if (type === 'grammar') continue;
    const target = card['front'].trim();
    const key = foldForMatch(target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    filled.push({
      target,
      learner: card['back'].trim(),
      example_target: target,
      example_learner: card['back'].trim(),
    });
  }
  if (filled.length === 0) return;
  input['vocabulary'] = filled;
  messages.push(`vocabulary: ${filled.length} entries copied from flashcards`);
}

function salvageQuotes(input: Obj, transcript: string, messages: string[]): void {
  const quotes = input['quotes'];
  if (!Array.isArray(quotes)) return;

  const kept: unknown[] = [];
  for (const quote of quotes) {
    if (!isObj(quote) || !isText(quote['text'])) {
      messages.push('quotes: dropped empty or non-object entry');
      continue;
    }
    const text = quote['text'];
    if (isJunkQuoteText(text)) {
      messages.push(`quotes: dropped speaker-label ${JSON.stringify(text).slice(0, 80)}`);
      continue;
    }
    if (transcript.trim() && !quoteAppearsInTranscript(text, transcript)) {
      messages.push(`quotes: dropped invented ${JSON.stringify(text).slice(0, 80)}`);
      continue;
    }
    kept.push(quote);
  }
  if (kept.length !== quotes.length) input['quotes'] = kept;
}
