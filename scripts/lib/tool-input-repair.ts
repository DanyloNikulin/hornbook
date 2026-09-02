// Defensive normalization for Claude's forced-tool_use lesson output.
//
// Observed failure (process-lesson run 29360203093): the model returned the
// `slides` field as a JSON-*string* instead of an array (double encoding),
// and inside that string the text_md values contained unescaped double
// quotes (`cosa c'è nei fusilli "a modo vostro"?`), so even JSON.parse of
// the embedded string failed. Zod then rejected the whole lesson and the
// run died after the (expensive) API call had already been paid for.
//
// This module repairs exactly that shape of breakage — nothing more:
//   1. A field that the Lesson schema expects to be an array arrived as a
//      string → try JSON.parse.
//   2. If that fails, escape unescaped `"` inside single-line string values
//      of the pretty-printed embedded JSON and parse again.
//   3. If that still fails, leave the field untouched so the existing Zod
//      validation fails loudly, same as before.
//
// Every successful coercion is reported back to the caller so extract.ts can
// print it to the CI log — repairs must be visible, never silent.

/** Top-level Lesson fields (plus the suggested_new_topics side channel) that
 * must be arrays; these are the candidates for string→JSON coercion. */
const ARRAY_FIELDS = [
  'vocabulary',
  'grammar',
  'quotes',
  'quiz',
  'flashcards',
  'slides',
  'related',
  'topics',
  'suggested_new_topics',
] as const;

// Raw NUL can't occur inside the embedded JSON (an unescaped control char is
// invalid in JSON strings and would fail the parse regardless), so it's a
// collision-free swap placeholder for already-escaped quotes.
const ESCAPED_QUOTE_SENTINEL = `${String.fromCharCode(0)}eq${String.fromCharCode(0)}`;

/**
 * Escape unescaped double quotes inside string values of pretty-printed
 * JSON. Assumes the layout Claude produces when it double-encodes: one
 * `"key": "value"` member or one bare `"element"` per line, with real
 * newlines only between members (newlines inside values are already `\n`
 * escapes). Content quotes are everything between the opening quote and the
 * *last* quote on the line.
 */
export function repairUnescapedQuotes(embedded: string): string {
  return embedded
    .split('\n')
    .map((line) => {
      const m =
        line.match(/^(\s*"[A-Za-z0-9_]+":\s*")(.*)(",?\s*)$/) ??
        line.match(/^(\s*")(.*)(",?\s*)$/);
      if (!m) return line;
      const [, prefix, content, suffix] = m;
      const fixed = content
        .replaceAll('\\"', ESCAPED_QUOTE_SENTINEL)
        .replaceAll('"', '\\"')
        .replaceAll(ESCAPED_QUOTE_SENTINEL, '\\"');
      return prefix + fixed + suffix;
    })
    .join('\n');
}

/**
 * Coerce array-typed fields that arrived as JSON-encoded strings, mutating
 * `input` in place. Returns one human-readable message per repaired field;
 * fields that cannot be repaired are left as-is for Zod to reject loudly.
 */
export function coerceStringifiedFields(input: Record<string, unknown>): string[] {
  const messages: string[] = [];
  for (const field of ARRAY_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    let parsed: unknown;
    let how: string;
    try {
      parsed = JSON.parse(value);
      how = 'plain JSON.parse';
    } catch {
      try {
        parsed = JSON.parse(repairUnescapedQuotes(value));
        how = 'JSON.parse after escaping unescaped inner quotes';
      } catch {
        continue;
      }
    }
    input[field] = parsed;
    messages.push(
      `field '${field}' arrived as a ${value.length}-char string instead of an array — coerced via ${how}`,
    );
  }
  return messages;
}
