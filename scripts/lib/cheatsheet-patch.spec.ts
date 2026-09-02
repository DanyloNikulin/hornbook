import { describe, it, expect, vi } from 'vitest';
import type { CheatsheetSectionT, CheatsheetT } from '../../src/lib/schema.ts';
import { applyPatches, type CheatsheetPatch } from './cheatsheet-patch.ts';

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeSection(
  id: string,
  overrides: Partial<CheatsheetSectionT> = {},
): CheatsheetSectionT {
  return {
    id,
    title: `Section ${id}`,
    main_table: undefined,
    exception_tables: [],
    notes: [],
    source_lessons: [],
    ...overrides,
  };
}

function emptyCheatsheet(): CheatsheetT {
  return { processed_lessons: [], categories: [] };
}

function seededCheatsheet(): CheatsheetT {
  return {
    processed_lessons: ['lesson-1'],
    updated_at: '2026-05-01',
    categories: [
      {
        id: 'chasy',
        title: 'Часи дієслова',
        sections: [
          makeSection('presente', { source_lessons: ['lesson-1'] }),
          makeSection('passato-prossimo', { source_lessons: ['lesson-1'] }),
        ],
      },
      {
        id: 'artikli',
        title: 'Артиклі',
        sections: [makeSection('oznacheni-artykli')],
      },
    ],
  };
}

// ── applyPatches: add_sections ───────────────────────────────────────────────

describe('applyPatches — add_sections', () => {
  it('creates a new category when patching one that does not exist', () => {
    const out = applyPatches(emptyCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('presente')],
      },
    ]);
    expect(out.categories).toHaveLength(1);
    expect(out.categories[0]).toEqual({
      id: 'chasy',
      title: 'chasy', // unknown id — title falls back to the id itself
      sections: [makeSection('presente')],
    });
  });

  it('appends sections to an existing category, preserving order', () => {
    const out = applyPatches(seededCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('imperfetto')],
      },
    ]);
    const ids = out.categories.find((c) => c.id === 'chasy')!.sections.map((s) => s.id);
    expect(ids).toEqual(['presente', 'passato-prossimo', 'imperfetto']);
  });

  it('skips sections whose id is already present (idempotency)', () => {
    const out = applyPatches(seededCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('presente', { title: 'IGNORED' })],
      },
    ]);
    const presente = out.categories
      .find((c) => c.id === 'chasy')!
      .sections.find((s) => s.id === 'presente')!;
    expect(presente.title).toBe('Section presente'); // original kept, NOT overwritten
  });

  it('uses category id as title fallback when id is not a canonical one', () => {
    const out = applyPatches(emptyCheatsheet(), [
      {
        category_id: 'unknown-cat',
        operation: 'add_sections',
        sections: [makeSection('s1')],
      },
    ]);
    expect(out.categories[0]?.title).toBe('unknown-cat');
  });
});

// ── applyPatches: update_sections ────────────────────────────────────────────

describe('applyPatches — update_sections', () => {
  it('replaces an existing section in place by id', () => {
    const out = applyPatches(seededCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'update_sections',
        sections: [makeSection('presente', { title: 'NEW TITLE', notes: ['updated'] })],
      },
    ]);
    const chasy = out.categories.find((c) => c.id === 'chasy')!;
    expect(chasy.sections.map((s) => s.id)).toEqual(['presente', 'passato-prossimo']);
    expect(chasy.sections[0]?.title).toBe('NEW TITLE');
    expect(chasy.sections[0]?.notes).toEqual(['updated']);
  });

  it('appends sections that did not previously exist (forgiving update)', () => {
    const out = applyPatches(seededCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'update_sections',
        sections: [makeSection('imperfetto', { title: 'Imperfetto' })],
      },
    ]);
    const chasy = out.categories.find((c) => c.id === 'chasy')!;
    expect(chasy.sections.map((s) => s.id)).toEqual([
      'presente',
      'passato-prossimo',
      'imperfetto',
    ]);
  });
});

// ── applyPatches: remove_sections ────────────────────────────────────────────

describe('applyPatches — remove_sections', () => {
  it('removes sections by id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = applyPatches(seededCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'remove_sections',
        section_ids: ['presente'],
      },
    ]);
    const chasy = out.categories.find((c) => c.id === 'chasy')!;
    expect(chasy.sections.map((s) => s.id)).toEqual(['passato-prossimo']);
    warn.mockRestore();
  });

  it('ignores ids that do not exist (idempotency)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = seededCheatsheet();
    const out = applyPatches(before, [
      {
        category_id: 'chasy',
        operation: 'remove_sections',
        section_ids: ['does-not-exist'],
      },
    ]);
    const chasy = out.categories.find((c) => c.id === 'chasy')!;
    expect(chasy.sections.map((s) => s.id)).toEqual(['presente', 'passato-prossimo']);
    // No warn for a no-op remove — legitimate idempotent path.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Defense in depth: Claude is prompted to ENRICH, not rewrite. A stray
  // remove_sections is more likely a hallucination than intent, so we warn
  // on every actual removal so it shows up in CI logs.
  it('logs a warning on every actual removal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyPatches(seededCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'remove_sections',
        section_ids: ['presente', 'passato-prossimo', 'does-not-exist'],
      },
    ]);
    // Two existing sections were removed; the third is a no-op and stays silent.
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

// ── applyPatches: purity and idempotency ─────────────────────────────────────

describe('applyPatches — purity', () => {
  it('does not mutate the input cheatsheet', () => {
    const before = seededCheatsheet();
    const snapshot = JSON.parse(JSON.stringify(before));
    applyPatches(before, [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('imperfetto')],
      },
    ]);
    expect(before).toEqual(snapshot);
  });

  it('does not mutate the input categories array', () => {
    const before = seededCheatsheet();
    const lenBefore = before.categories.length;
    applyPatches(before, [
      {
        category_id: 'new-cat',
        operation: 'add_sections',
        sections: [makeSection('x')],
      },
    ]);
    expect(before.categories).toHaveLength(lenBefore);
  });
});

describe('applyPatches — idempotency', () => {
  it('applying the same patch twice equals applying it once', () => {
    const patches: CheatsheetPatch[] = [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('imperfetto')],
      },
      {
        category_id: 'chasy',
        operation: 'update_sections',
        sections: [makeSection('presente', { title: 'Updated' })],
      },
    ];
    const once = applyPatches(seededCheatsheet(), patches);
    const twice = applyPatches(once, patches);
    expect(twice).toEqual(once);
  });

  it('add then remove yields the original state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = seededCheatsheet();
    const added = applyPatches(before, [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('imperfetto')],
      },
    ]);
    const removed = applyPatches(added, [
      {
        category_id: 'chasy',
        operation: 'remove_sections',
        section_ids: ['imperfetto'],
      },
    ]);
    expect(removed).toEqual(before);
    warn.mockRestore();
  });
});

// ── applyPatches: ordering ──────────────────────────────────────────────────

describe('applyPatches — multi-patch ordering', () => {
  it('processes patches in order, accumulating state', () => {
    const out = applyPatches(emptyCheatsheet(), [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('a')],
      },
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('b')],
      },
      {
        category_id: 'chasy',
        operation: 'update_sections',
        sections: [makeSection('a', { title: 'A-updated' })],
      },
      {
        category_id: 'chasy',
        operation: 'remove_sections',
        section_ids: ['b'],
      },
    ]);
    const chasy = out.categories.find((c) => c.id === 'chasy')!;
    expect(chasy.sections.map((s) => s.id)).toEqual(['a']);
    expect(chasy.sections[0]?.title).toBe('A-updated');
  });

  it('newly-introduced categories appear in patch-arrival order', () => {
    const out = applyPatches(emptyCheatsheet(), [
      {
        category_id: 'konstruktsii',
        operation: 'add_sections',
        sections: [makeSection('mi-piace')],
      },
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('presente')],
      },
    ]);
    expect(out.categories.map((c) => c.id)).toEqual(['konstruktsii', 'chasy']);
  });

  it('preserves processed_lessons and updated_at on the input', () => {
    const before = seededCheatsheet();
    const out = applyPatches(before, [
      {
        category_id: 'chasy',
        operation: 'add_sections',
        sections: [makeSection('imperfetto')],
      },
    ]);
    expect(out.processed_lessons).toEqual(before.processed_lessons);
    expect(out.updated_at).toBe(before.updated_at);
  });
});
