import { describe, it, expect } from 'vitest';
import { ensureUniqueSlug } from './slug.ts';

const existing = new Map<string, string>([
  ['passato-prossimo', '2026-06-20-passato-prossimo.json'],
  ['imperfetto', '2026-07-14-imperfetto.json'],
  ['futuro-2', '2026-08-22-futuro-2.json'],
]);

describe('ensureUniqueSlug', () => {
  it('returns the slug unchanged when nothing uses it', () => {
    expect(ensureUniqueSlug('condizionale', '2026-09-05', existing)).toBe('condizionale');
  });

  it('keeps the slug when the only match is the same lesson being re-processed', () => {
    expect(ensureUniqueSlug('passato-prossimo', '2026-06-20', existing)).toBe('passato-prossimo');
  });

  it('suffixes -2 when another lesson (different date) already owns the slug', () => {
    expect(ensureUniqueSlug('passato-prossimo', '2026-01-01', existing)).toBe('passato-prossimo-2');
  });

  it('skips suffixes that are themselves taken', () => {
    expect(ensureUniqueSlug('futuro', '2026-09-05', new Map([...existing, ['futuro', '2026-08-15-futuro.json']]))).toBe(
      'futuro-3',
    );
  });

  it('treats a taken suffix as free when it belongs to the same lesson', () => {
    expect(ensureUniqueSlug('futuro', '2026-08-22', new Map([...existing, ['futuro', '2026-08-15-futuro.json']]))).toBe(
      'futuro-2',
    );
  });

  it('works with an empty map', () => {
    expect(ensureUniqueSlug('x', '2026-01-01', new Map())).toBe('x');
  });
});
