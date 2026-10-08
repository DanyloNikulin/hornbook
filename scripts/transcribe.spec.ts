import { describe, expect, it } from 'vitest';
import { planChunks } from './transcribe.ts';

describe('planChunks', () => {
  it('cuts a lesson into chunks that run a little into the next one', () => {
    expect(planChunks(400, 180, 5)).toEqual([
      { start: 0, dur: 185 },
      { start: 180, dur: 185 },
      { start: 360, dur: 40 },
    ]);
  });

  it('covers a 63-minute lesson in three-minute chunks with nothing left over', () => {
    const chunks = planChunks(3770.6, 180, 5);
    expect(chunks).toHaveLength(21);
    const last = chunks.at(-1)!;
    expect(last.start + last.dur).toBeCloseTo(3770.6);
  });

  it('ends where the overlap already reaches the end, never in a sliver', () => {
    expect(planChunks(360.5, 180, 5)).toEqual([
      { start: 0, dur: 185 },
      { start: 180, dur: 180.5 },
    ]);
    expect(planChunks(1800.5, 900, 30).map((c) => c.start)).toEqual([0, 900]);
  });

  it('keeps one chunk for a recording shorter than a chunk', () => {
    expect(planChunks(24, 900, 30)).toEqual([{ start: 0, dur: 24 }]);
  });
});
