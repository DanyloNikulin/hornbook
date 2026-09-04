import type { ReleaseCheckView, ReleaseInfo } from '../src/lib/api-types.ts';

export const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/DanyloNikulin/hornbook/releases/latest';
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FORCED_UPDATE_INTERVAL_MS = 60 * 1000;

export interface ReleaseCheckerOptions {
  currentVersion: string;
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** One cached GET to the public release feed, shared by the shell and API. */
export class ReleaseChecker {
  private cached: ReleaseCheckView | null = null;
  private lastFetchAt = 0;

  constructor(private readonly opts: ReleaseCheckerOptions) {}

  async check(force = false): Promise<ReleaseCheckView> {
    const now = (this.opts.now ?? Date.now)();
    if (force && this.cached && now - this.lastFetchAt < FORCED_UPDATE_INTERVAL_MS) return this.cached;
    if (!force && this.cached && now - Date.parse(this.cached.checkedAt) < UPDATE_INTERVAL_MS) return this.cached;
    const checkedAt = new Date(now).toISOString();
    this.lastFetchAt = now;
    try {
      const response = await (this.opts.fetch ?? fetch)(this.opts.url ?? DEFAULT_RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `hornbook/${this.opts.currentVersion}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`release feed returned HTTP ${response.status}`);
      const release = parseRelease(await response.json());
      this.cached = {
        currentVersion: this.opts.currentVersion,
        checkedAt,
        available: compareVersions(release.version, this.opts.currentVersion) > 0,
        release,
      };
    } catch (error) {
      this.cached = {
        currentVersion: this.opts.currentVersion,
        checkedAt,
        available: false,
        error: (error as Error).message,
      };
    }
    return this.cached;
  }
}

export function parseRelease(raw: unknown): ReleaseInfo {
  if (!raw || typeof raw !== 'object') throw new Error('release feed returned an invalid response');
  const value = raw as Record<string, unknown>;
  const tag = typeof value['tag_name'] === 'string' ? value['tag_name'].trim() : '';
  const version = normalizeVersion(tag);
  if (!version) throw new Error('release feed did not contain a semantic version tag');
  const url = typeof value['html_url'] === 'string' && /^https:\/\//.test(value['html_url']) ? value['html_url'] : '';
  return {
    version,
    name: typeof value['name'] === 'string' && value['name'].trim() ? value['name'].trim() : `Hornbook ${version}`,
    notes: typeof value['body'] === 'string' ? value['body'].trim() : '',
    url,
    ...(typeof value['published_at'] === 'string' ? { publishedAt: value['published_at'] } : {}),
  };
}

export function normalizeVersion(value: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}` : null;
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
}

function parts(value: string): { numbers: number[]; pre: string } | null {
  const normalized = normalizeVersion(value);
  if (!normalized) return null;
  const [core, pre = ''] = normalized.split('-', 2);
  return { numbers: core.split('.').map(Number), pre };
}
