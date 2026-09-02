import { describe, it, expect } from 'vitest';
import { detectTopics } from './topics';

describe('detectTopics', () => {
  it('returns empty array for unrelated text', () => {
    expect(detectTopics('hello world, this is unrelated')).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(detectTopics('')).toEqual([]);
  });

  it('detects grammar', () => {
    expect(detectTopics('Today we study grammar and conjugation.')).toContain('grammar');
  });

  it('detects vocabulary', () => {
    expect(detectTopics('New vocabulary: the word list for shops.')).toContain('vocabulary');
  });

  it('detects pronunciation', () => {
    expect(detectTopics('Pronunciation of the letter r.')).toContain('pronunciation');
  });

  it('is deterministic', () => {
    const a = detectTopics('grammar vocabulary');
    const b = detectTopics('vocabulary grammar');
    expect(a).toEqual(b);
  });
});
