import { describe, it, expect } from 'vitest';
import { INITIAL, rate, isDue, cardId, today } from './sm2';
import type { Sm2State } from './sm2';

describe('sm2 — rate()', () => {
  it('rating < 3 resets repetitions and sets interval to 1', () => {
    const prev: Sm2State = { interval: 30, ef: 2.8, repetitions: 5, due: '2026-01-01' };
    const next = rate(prev, 1, '2026-05-23');
    expect(next.repetitions).toBe(0);
    expect(next.interval).toBe(1);
    expect(next.due).toBe('2026-05-24');
  });

  it('first successful rep → interval 1', () => {
    const next = rate(INITIAL, 3, '2026-05-23');
    expect(next.repetitions).toBe(1);
    expect(next.interval).toBe(1);
  });

  it('second successful rep → interval 6', () => {
    const prev: Sm2State = { interval: 1, ef: 2.5, repetitions: 1, due: '2026-05-23' };
    const next = rate(prev, 3, '2026-05-23');
    expect(next.repetitions).toBe(2);
    expect(next.interval).toBe(6);
  });

  it('third+ successful rep → interval grows by ef factor', () => {
    const prev: Sm2State = { interval: 6, ef: 2.5, repetitions: 2, due: '2026-05-23' };
    const next = rate(prev, 3, '2026-05-23');
    expect(next.repetitions).toBe(3);
    expect(next.interval).toBe(15); // round(6 * 2.5)
  });

  it('ef clamps at 1.3 even after many bad ratings', () => {
    let s: Sm2State = { interval: 1, ef: 1.4, repetitions: 0, due: '2026-05-23' };
    for (let i = 0; i < 10; i++) s = rate(s, 1, '2026-05-23');
    expect(s.ef).toBeGreaterThanOrEqual(1.3);
  });

  it('ef grows on rating=5', () => {
    const next = rate(INITIAL, 5, '2026-05-23');
    expect(next.ef).toBeGreaterThan(INITIAL.ef);
  });

  it('due date advances by interval days', () => {
    const next = rate(INITIAL, 3, '2026-05-23');
    expect(next.due).toBe('2026-05-24'); // interval=1
  });
});

describe('sm2 — isDue()', () => {
  it('returns true when due date is today or past', () => {
    expect(isDue({ interval: 1, ef: 2.5, repetitions: 1, due: '2026-05-23' }, '2026-05-23')).toBe(
      true,
    );
    expect(isDue({ interval: 1, ef: 2.5, repetitions: 1, due: '2026-05-22' }, '2026-05-23')).toBe(
      true,
    );
  });

  it('returns false when due date is in the future', () => {
    expect(isDue({ interval: 1, ef: 2.5, repetitions: 1, due: '2026-05-24' }, '2026-05-23')).toBe(
      false,
    );
  });

  it('INITIAL (due=today) is due', () => {
    expect(isDue(INITIAL, today())).toBe(true);
  });
});

describe('sm2 — today()', () => {
  it('formats the local calendar date instead of serializing through UTC', () => {
    const localJustAfterMidnight = {
      getFullYear: () => 2026,
      getMonth: () => 7,
      getDate: () => 30,
    } as Date;
    expect(today(localJustAfterMidnight)).toBe('2026-08-30');
  });

  it('zero-pads local months and days', () => {
    expect(today(new Date(2026, 0, 2, 12, 0))).toBe('2026-01-02');
  });
});

describe('sm2 — cardId()', () => {
  it('is stable for identical input', () => {
    expect(cardId('ciao', 'привіт')).toBe(cardId('ciao', 'привіт'));
  });

  it('differs for different front', () => {
    expect(cardId('ciao', 'привіт')).not.toBe(cardId('buongiorno', 'привіт'));
  });

  it('differs for different back', () => {
    expect(cardId('ciao', 'привіт')).not.toBe(cardId('ciao', 'добридень'));
  });

  it('returns a non-empty string', () => {
    const id = cardId('x', 'y');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});
