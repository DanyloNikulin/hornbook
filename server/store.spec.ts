import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FolderStore, HttpError } from './store.ts';
import { setJournalDir } from '../scripts/lib/journal.ts';

function lesson(slug: string, date = '2026-01-01', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `${date}-${slug}`,
    date,
    slug,
    title: `Lesson ${slug}`,
    summary: 'A summary.',
    article_md: '## Takeaway\n\nSomething.',
    vocabulary: [{ target: 'hola', learner: 'hello', level: 'A1' }],
    ...extra,
  };
}

let dir: string;
let store: FolderStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hornbook-store-'));
  store = new FolderStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FolderStore — journal bootstrap', () => {
  it('creates a default config in an empty folder', () => {
    expect(existsSync(join(dir, 'journal.config.json'))).toBe(true);
    const c = store.config();
    expect(c.brand.name).toBe('Hornbook');
    expect(c.sections).toEqual([]);
  });

  it('reads a legacy single-pair config as one section', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'hornbook-legacy-'));
    writeFileSync(
      join(legacy, 'journal.config.json'),
      JSON.stringify({
        pair: { target: 'it', learner: 'en' },
        brand: { name: 'X', tagline: 'y' },
        providers: { transcribe: { driver: 'openai', model: 'm' }, extract: { driver: 'ollama', model: 'm' } },
      }),
    );
    const s = new FolderStore(legacy);
    expect(s.config().sections.map((x) => x.id)).toEqual(['it-en']);
    rmSync(legacy, { recursive: true, force: true });
    setJournalDir(dir);
  });
});

describe('FolderStore — sections', () => {
  it('creates a section folder with derived data and a label with flags', () => {
    const s = store.createSection({ target: 'es', learner: 'en' });
    expect(s.id).toBe('es-en');
    expect(s.label).toBe('Spanish → English');
    expect(s.flags.target).toBe('🇪🇸');
    expect(existsSync(join(dir, 'es-en', '_derived', 'meta.json'))).toBe(true);
    expect(store.config().sections).toHaveLength(1);
  });

  it('rejects duplicates, same-language pairs and bad codes', () => {
    store.createSection({ target: 'es', learner: 'en' });
    expect(() => store.createSection({ target: 'es', learner: 'en' })).toThrow(HttpError);
    expect(() => store.createSection({ target: 'es', learner: 'es' })).toThrow(/differ/);
    expect(() => store.createSection({ target: 'spanish', learner: 'en' })).toThrow(HttpError);
  });

  it('updates title and theme, and refuses to delete a section with lessons', () => {
    store.createSection({ target: 'es', learner: 'en' });
    const updated = store.updateSection('es-en', { title: 'Mi español', theme: { primary: '#c0653f' } });
    expect(updated.title).toBe('Mi español');
    expect(updated.label).toBe('Mi español');
    expect(updated.theme?.primary).toBe('#c0653f');

    store.saveLesson('es-en', lesson('greetings'));
    expect(() => store.deleteSection('es-en')).toThrow(/still has lessons/);
    store.deleteLesson('es-en', 'greetings');
    store.deleteSection('es-en');
    expect(existsSync(join(dir, 'es-en'))).toBe(false);
    expect(store.config().sections).toEqual([]);
  });
});

describe('FolderStore — lessons and derived data', () => {
  beforeEach(() => {
    store.createSection({ target: 'es', learner: 'en' });
  });

  it('saves a lesson as json + md and rebuilds derived files', () => {
    const saved = store.saveLesson('es-en', lesson('greetings'));
    expect(saved.id).toBe('2026-01-01-greetings');
    expect(existsSync(join(dir, 'es-en', '2026-01-01-greetings.json'))).toBe(true);
    expect(existsSync(join(dir, 'es-en', '2026-01-01-greetings.md'))).toBe(true);
    expect(store.lessonMetas('es-en').map((m) => m.slug)).toEqual(['greetings']);
    const vocab = JSON.parse(store.derived('es-en', 'vocab')) as { target: string }[];
    expect(vocab.map((v) => v.target)).toEqual(['hola']);
    const cards = JSON.parse(store.derived('es-en', 'cards')) as unknown[];
    expect(cards).toHaveLength(2);
    expect(JSON.parse(store.derived('es-en', 'search-index'))).toHaveLength(2);
  });

  it('rejects an invalid lesson and a slug taken by another date', () => {
    expect(() => store.saveLesson('es-en', { id: 'x' })).toThrow(HttpError);
    store.saveLesson('es-en', lesson('greetings', '2026-01-01'));
    expect(() => store.saveLesson('es-en', lesson('greetings', '2026-02-02'))).toThrow(/already used/);
    // Same date + slug is an overwrite, not a conflict.
    store.saveLesson('es-en', lesson('greetings', '2026-01-01', { title: 'Updated' }));
    expect(store.lesson('es-en', 'greetings').title).toBe('Updated');
  });

  it('returns 404-style errors for unknown sections and lessons', () => {
    expect(() => store.lesson('nope', 'x')).toThrow(/Unknown section/);
    expect(() => store.lesson('es-en', 'missing')).toThrow(/No lesson/);
  });

  it('serves an empty cheat sheet when none exists', () => {
    expect(store.cheatsheet('es-en')).toEqual({ processed_lessons: [], categories: [] });
  });

  it('metas are newest first', () => {
    store.saveLesson('es-en', lesson('old', '2026-01-01'));
    store.saveLesson('es-en', lesson('new', '2026-03-01'));
    expect(store.lessonMetas('es-en').map((m) => m.slug)).toEqual(['new', 'old']);
  });
});

describe('FolderStore — progress', () => {
  beforeEach(() => {
    store.createSection({ target: 'es', learner: 'en' });
  });

  it('starts empty, round-trips, and validates', () => {
    expect(store.progress('es-en')).toEqual({ sm2: {}, daily: null, quiz: {}, activity: {} });
    const next = {
      sm2: { abc: { interval: 1, ef: 2.5, repetitions: 1, due: '2026-01-02' } },
      daily: { date: '2026-01-01', target_learner: 2, learner_target: 0, pairs: 1 },
      quiz: { greetings: { best_score: 3, total: 5, attempts: 1, last_at: '2026-01-01T10:00:00Z' } },
      activity: { '2026-01-01': 3 },
    };
    store.saveProgress('es-en', next);
    expect(store.progress('es-en')).toEqual(next);
    expect(JSON.parse(readFileSync(join(dir, 'es-en', '_progress.json'), 'utf8'))).toEqual(next);
    expect(() => store.saveProgress('es-en', { sm2: 'bad' })).toThrow(HttpError);
  });

  it('sets a corrupt progress file aside instead of failing', () => {
    mkdirSync(join(dir, 'es-en'), { recursive: true });
    writeFileSync(join(dir, 'es-en', '_progress.json'), JSON.stringify({ sm2: 'nope' }));
    expect(store.progress('es-en').sm2).toEqual({});
  });
});
