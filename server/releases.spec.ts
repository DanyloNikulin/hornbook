import { describe, expect, it, vi } from 'vitest';
import { compareVersions, parseRelease, ReleaseChecker } from './releases.ts';

describe('release checks', () => {
  it('compares stable semantic versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
  });

  it('parses the public release fields only', () => {
    expect(parseRelease({ tag_name: 'v0.2.0', name: 'Hornbook 0.2', body: 'Notes', html_url: 'https://github.com/x', published_at: '2026-09-05' })).toEqual({
      version: '0.2.0', name: 'Hornbook 0.2', notes: 'Notes', url: 'https://github.com/x', publishedAt: '2026-09-05',
    });
  });

  it('uses one automatic GET per day and rate-limits forced checks', async () => {
    let now = Date.parse('2026-09-04T10:00:00Z');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v0.2.0', name: 'Hornbook 0.2', body: '', html_url: 'https://github.com/x' }), { status: 200 }));
    const checker = new ReleaseChecker({ currentVersion: '0.1.0', fetch: fetchImpl as typeof fetch, now: () => now });
    expect((await checker.check()).available).toBe(true);
    now += 1000;
    await checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await checker.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 60_000;
    await checker.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await checker.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
