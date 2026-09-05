import { beforeEach, expect, it } from 'vitest';
import { ProgressDrafts } from './progress-drafts.service';
import { EMPTY_PROGRESS } from '../lib/schema';

beforeEach(() => localStorage.clear());
it("can discard the exact unreadable draft without deleting another tab's newer copy", () => {
  const key = 'hornbook-progress:journal:es-en:old';
  localStorage.setItem(key, '{broken');
  const drafts = new ProgressDrafts();
  expect(() => drafts.read('journal', 'es-en')).toThrow();
  const newer = JSON.stringify({ revision: 'r1', snapshot: structuredClone(EMPTY_PROGRESS) });
  localStorage.setItem(key, newer);
  drafts.write('journal', 'es-en', null);
  expect(localStorage.getItem(key)).toBe(newer);
  localStorage.setItem(key, '{broken');
  expect(() => drafts.read('journal', 'es-en')).toThrow();
  drafts.write('journal', 'es-en', null);
  expect(localStorage.getItem(key)).toBeNull();
});
it('preserves newer draft changes made by another tab while a recovered copy is being saved', () => {
  const first = new ProgressDrafts();
  const second = new ProgressDrafts();
  const original = {
    revision: 'r0',
    snapshot: { ...structuredClone(EMPTY_PROGRESS), activity: { '2026-09-04': 1 } },
  };
  first.write('journal', 'es-en', original);
  expect(second.read('journal', 'es-en')).toEqual(original);
  const newer = { ...original, snapshot: { ...original.snapshot, activity: { '2026-09-04': 2 } } };
  first.write('journal', 'es-en', newer);
  second.write('journal', 'es-en', null);
  expect(first.read('journal', 'es-en')).toEqual(newer);
});
it('a new browser session can restore a closed tab draft without mixing journals', () => {
  const draft = { revision: 'r0', snapshot: structuredClone(EMPTY_PROGRESS) };
  new ProgressDrafts().write('journal-a', 'es-en', draft);
  const reopened = new ProgressDrafts();
  expect(reopened.read('journal-b', 'es-en')).toBeNull();
  expect(reopened.read('journal-a', 'it-en')).toBeNull();
  expect(reopened.read('journal-a', 'es-en')).toEqual(draft);
  reopened.write('journal-a', 'es-en', null);
  expect(localStorage.length).toBe(0);
});
