import { describe, expect, it, vi } from 'vitest';
import { allowsPrereleases, compareVersions, DEFAULT_RELEASES_URL, parseRelease, ReleaseChecker } from './releases.ts';

describe('release checks', () => {
  it('discovers a GitHub preview from the release list for a 0.x installation', async () => {
    const fetchImpl = vi.fn(async () => Response.json([
      { tag_name: 'v0.9.1', prerelease: true, html_url: 'https://github.com/fixture/releases/tag/v0.9.1' },
    ]));
    const result = await new ReleaseChecker({ currentVersion: '0.9.0', fetch: fetchImpl }).check();
    expect(fetchImpl).toHaveBeenCalledWith(DEFAULT_RELEASES_URL, expect.any(Object));
    expect(DEFAULT_RELEASES_URL).toBe('https://api.github.com/repos/DanyloNikulin/hornbook/releases?per_page=100');
    expect(result).toMatchObject({ available: true, release: { version: '0.9.1' } });
    expect(result.error).toBeUndefined();
  });

  it('selects the newest eligible version regardless of feed order and skips drafts and unrelated tags', async () => {
    const fetchImpl = vi.fn(async () => Response.json([
      { tag_name: 'v0.8.0', prerelease: true },
      { tag_name: 'v9.0.0', draft: true },
      { tag_name: 'nightly', prerelease: true },
      { tag_name: 'v1.0.0', prerelease: false },
      { tag_name: 'v0.9.1', prerelease: true },
    ]));
    expect(await new ReleaseChecker({ currentVersion: '0.9.0', fetch: fetchImpl }).check())
      .toMatchObject({ available: true, release: { version: '1.0.0' } });
  });

  it('keeps stable installations on stable releases', async () => {
    const fetchImpl = vi.fn(async () => Response.json([
      { tag_name: 'v2.0.0', prerelease: true },
      { tag_name: 'v3.0.0-beta.1', prerelease: false },
      { tag_name: 'v1.1.0', prerelease: false },
    ]));
    expect(await new ReleaseChecker({ currentVersion: '1.0.0', fetch: fetchImpl }).check())
      .toMatchObject({ available: true, release: { version: '1.1.0' } });
  });

  it.each([{ feed: [] }, { feed: [{ tag_name: 'v2.0.0', prerelease: true }] }])('handles a feed without eligible releases as no update: $feed', async ({ feed }) => {
    const result = await new ReleaseChecker({ currentVersion: '1.0.0', fetch: async () => Response.json(feed) }).check();
    expect(result).toMatchObject({ available: false });
    expect(result.release).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('does not offer an older preview as an update', async () => {
    const result = await new ReleaseChecker({ currentVersion: '0.9.1', fetch: async () => Response.json([{ tag_name: 'v0.9.0', prerelease: true }]) }).check();
    expect(result).toMatchObject({ available: false, release: { version: '0.9.0' } });
  });

  it.each([404, 403, 500])('preserves HTTP %i feed errors', async (status) => {
    const result = await new ReleaseChecker({ currentVersion: '0.9.0', fetch: async () => new Response('', { status }) }).check();
    expect(result).toMatchObject({ available: false, error: `release feed returned HTTP ${status}` });
  });

  it('uses the same preview policy for discovery and desktop installation', () => {
    expect(allowsPrereleases('0.9.0')).toBe(true);
    expect(allowsPrereleases('1.0.0-beta.1')).toBe(true);
    expect(allowsPrereleases('1.0.0')).toBe(false);
    expect(allowsPrereleases('invalid')).toBe(false);
  });

  it('shares an in-flight request across forced and automatic callers', async () => {
    let resolve!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const checker = new ReleaseChecker({ currentVersion: '1.0.0', fetch: fetchImpl });
    const first = checker.check(); const second = checker.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ tag_name: 'v1.1.0', html_url: 'https://github.com/fixture' })));
    expect(await first).toEqual(await second);
  });
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
