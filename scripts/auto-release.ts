import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { releaseMetadata } from './lib/release.ts';
import { isMain } from './lib/is-main.ts';

interface ReleaseInput {
  version: string;
  previousVersion: string;
  revision: string;
  mainRevision: string;
  existingTagRevision?: string;
  published: boolean;
}

export function planRelease(input: ReleaseInput): 'skip' | 'create' | 'resume' {
  if (input.revision !== input.mainRevision || input.version === input.previousVersion)
    return 'skip';
  if (![input.version, input.previousVersion].every((version) => /^\d+\.\d+\.\d+$/.test(version))) {
    throw new Error('Automatic releases require stable semantic versions');
  }
  const current = input.version.split('.').map(Number);
  const previous = input.previousVersion.split('.').map(Number);
  const difference = current
    .map((part, index) => part - previous[index])
    .find((part) => part !== 0);
  if (!difference || difference < 0)
    throw new Error('An automatic release requires an increased version');
  if (input.existingTagRevision && input.existingTagRevision !== input.revision) {
    throw new Error(
      `Version v${input.version} already belongs to another commit; increase the version`,
    );
  }
  if (input.published) return 'skip';
  return input.existingTagRevision ? 'resume' : 'create';
}

export function trustedMainRun(event: unknown, repository: string): boolean {
  const run = (
    event as {
      workflow_run?: {
        conclusion?: string;
        event?: string;
        head_branch?: string;
        head_repository?: { full_name?: string };
      };
    } | null
  )?.workflow_run;
  return (
    run?.conclusion === 'success' &&
    run.event === 'push' &&
    run.head_branch === 'main' &&
    run.head_repository?.full_name === repository
  );
}

export async function prepareAutomaticRelease(
  input: ReleaseInput,
  createTag: (tag: string, revision: string) => Promise<void>,
): Promise<boolean> {
  const plan = planRelease(input);
  if (plan === 'skip') return false;
  if (plan === 'create') await createTag(`v${input.version}`, input.revision);
  return true;
}

async function main(): Promise<void> {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const automatic = process.env['GITHUB_EVENT_NAME'] === 'workflow_run';
  const repository = process.env['GITHUB_REPOSITORY']!;
  const event = JSON.parse(readFileSync(process.env['GITHUB_EVENT_PATH']!, 'utf8'));
  if (automatic && !trustedMainRun(event, repository))
    throw new Error('Only successful main push runs may release');
  const revision = git('rev-parse', 'HEAD');
  if (automatic && revision !== event.workflow_run.head_sha)
    throw new Error('Checkout is not the verified commit');
  const metadata = releaseMetadata(
    readFileSync('package.json', 'utf8'),
    readFileSync('package-lock.json', 'utf8'),
    readFileSync('CHANGELOG.md', 'utf8'),
    automatic ? undefined : process.env['REQUESTED_TAG'],
  );
  let ready = true;
  if (automatic) {
    const api = async (path: string, method = 'GET', body?: unknown): Promise<Response> => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${process.env['GH_TOKEN']}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return response;
    };
    const mainResponse = await api('git/ref/heads/main');
    if (!mainResponse.ok) throw new Error(`Cannot read main: HTTP ${mainResponse.status}`);
    const mainRef = (await mainResponse.json()) as { object: { sha: string } };
    const previousVersion = (JSON.parse(git('show', 'HEAD^:package.json')) as { version: string })
      .version;
    let existingTagRevision: string | undefined;
    if (git('tag', '--list', metadata.tag))
      existingTagRevision = git('rev-parse', `${metadata.tag}^{commit}`);
    const releaseResponse = await api(`releases/tags/${metadata.tag}`);
    if (!releaseResponse.ok && releaseResponse.status !== 404)
      throw new Error(`Cannot read release: HTTP ${releaseResponse.status}`);
    const published =
      releaseResponse.ok && !((await releaseResponse.json()) as { draft: boolean }).draft;
    ready = await prepareAutomaticRelease(
      {
        version: metadata.version,
        previousVersion,
        revision,
        mainRevision: mainRef.object.sha,
        existingTagRevision,
        published,
      },
      async (tag, sha) => {
        const response = await api('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha });
        // Never update an existing ref, including when a concurrent creator wins.
        if (!response.ok) throw new Error(`Cannot create immutable tag: HTTP ${response.status}`);
      },
    );
  }
  appendFileSync(
    process.env['GITHUB_OUTPUT']!,
    `ready=${ready}\ntag=${metadata.tag}\nrevision=${revision}\n`,
  );
  console.log(
    ready
      ? `Release ${metadata.tag} at ${revision}`
      : 'No new version to release at the current main head',
  );
}

if (isMain(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
