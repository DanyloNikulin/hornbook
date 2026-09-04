export interface ReleaseMetadata {
  version: string;
  tag: string;
  notes: string;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

interface LockManifest extends PackageManifest {
  packages?: Record<string, PackageManifest>;
}

export function releaseMetadata(
  packageText: string,
  lockText: string,
  changelog: string,
  requestedTag?: string,
): ReleaseMetadata {
  const manifest = parseJson<PackageManifest>(packageText, 'package.json');
  const lock = parseJson<LockManifest>(lockText, 'package-lock.json');
  if (manifest.name !== 'hornbook') throw new Error('package.json must name the package "hornbook"');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('package.json must contain a stable semantic version');
  }

  const version = manifest.version;
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error(`package-lock.json is not aligned with version ${version}`);
  }
  const tag = `v${version}`;
  if (requestedTag && requestedTag !== tag) throw new Error(`Release tag must be ${tag}, got ${requestedTag}`);

  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^## ${escapeRegex(version)} — \\d{4}-\\d{2}-\\d{2}$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md has no dated ${version} section`);
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s/.test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  const notes = lines.slice(start + 1, end).join('\n').trim();
  if (!notes || /\b(?:TBD|TODO)\b/i.test(notes)) throw new Error(`CHANGELOG.md has no finished notes for ${version}`);

  return { version, tag, notes };
}

function parseJson<T>(text: string, name: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${(error as Error).message}`);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
