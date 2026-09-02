import { describe, it, expect } from 'vitest';
import { coerceStringifiedFields, repairUnescapedQuotes } from './tool-input-repair';

// Distilled from the real failure (run 29360203093): pretty-printed slides
// JSON where one text_md contains unescaped inner quotes.
const BROKEN_SLIDES = `[
  {
    "ts": "00:00:00",
    "text_md": "**AL RISTORANTE** — Wordwall: Carte a caso\\n\\nGioco di vocabolario."
  },
  {
    "ts": "00:31:15",
    "text_md": "- «Sì, ma prima una domanda: cosa c'è nei fusilli "a modo vostro"?»\\n- «Dunque, sono fusilli in salsa di pomodoro...»"
  }
]`;

describe('repairUnescapedQuotes', () => {
  it('escapes unescaped quotes inside a member string value', () => {
    const repaired = repairUnescapedQuotes(BROKEN_SLIDES);
    const parsed = JSON.parse(repaired);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].text_md).toContain('"a modo vostro"');
  });

  it('leaves already-valid JSON semantically unchanged', () => {
    const valid = JSON.stringify(
      [{ ts: '00:01:00', text_md: 'said «hi» and "quoted"' }],
      null,
      2,
    );
    expect(JSON.parse(repairUnescapedQuotes(valid))).toEqual(JSON.parse(valid));
  });

  it('handles bare string array elements', () => {
    const broken = `[
  "plain element",
  "element with "inner" quotes"
]`;
    expect(JSON.parse(repairUnescapedQuotes(broken))).toEqual([
      'plain element',
      'element with "inner" quotes',
    ]);
  });
});

describe('coerceStringifiedFields', () => {
  it('does nothing when fields are proper arrays', () => {
    const input: Record<string, unknown> = { slides: [], topics: ['presente'] };
    expect(coerceStringifiedFields(input)).toEqual([]);
    expect(input.topics).toEqual(['presente']);
  });

  it('parses a cleanly double-encoded field', () => {
    const input: Record<string, unknown> = { related: '["fare-espressioni"]' };
    const messages = coerceStringifiedFields(input);
    expect(input.related).toEqual(['fare-espressioni']);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("'related'");
    expect(messages[0]).toContain('plain JSON.parse');
  });

  it('repairs the run-29360203093 shape: stringified slides with unescaped quotes', () => {
    const input: Record<string, unknown> = { slides: BROKEN_SLIDES };
    const messages = coerceStringifiedFields(input);
    expect(Array.isArray(input.slides)).toBe(true);
    expect((input.slides as unknown[]).length).toBe(2);
    expect(messages[0]).toContain('escaping unescaped inner quotes');
  });

  it('leaves an unrepairable string untouched so Zod fails loudly', () => {
    const input: Record<string, unknown> = { quiz: 'not json at all {' };
    expect(coerceStringifiedFields(input)).toEqual([]);
    expect(input.quiz).toBe('not json at all {');
  });

  it('ignores string fields that are legitimately strings', () => {
    const input: Record<string, unknown> = { title: 'Al ristorante', article_md: '# x' };
    expect(coerceStringifiedFields(input)).toEqual([]);
    expect(input.title).toBe('Al ristorante');
  });
});
