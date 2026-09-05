import { describe, expect, it, vi } from 'vitest';
import { planRelease, prepareAutomaticRelease, trustedMainRun } from './auto-release.ts';

const bump = {
  version: '0.9.2',
  previousVersion: '0.9.1',
  revision: 'verified',
  mainRevision: 'verified',
  published: false,
};

describe('automatic release planning', () => {
  it('creates the new version tag at the verified commit', async () => {
    const create = vi.fn(async () => {});
    expect(await prepareAutomaticRelease(bump, create)).toBe(true);
    expect(create).toHaveBeenCalledExactlyOnceWith('v0.9.2', 'verified');
  });

  it.each([
    { ...bump, previousVersion: '0.9.2' },
    { ...bump, mainRevision: 'newer-main' },
    { ...bump, existingTagRevision: 'verified', published: true },
  ])('does not tag or publish an unchanged, stale or published version: %j', async (input) => {
    const create = vi.fn(async () => {});
    expect(await prepareAutomaticRelease(input, create)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('resumes an unpublished tag at the same verified commit without recreating it', async () => {
    const create = vi.fn(async () => {});
    expect(
      await prepareAutomaticRelease({ ...bump, existingTagRevision: 'verified' }, create),
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a tag owned by another commit even if its release exists', async () => {
    const create = vi.fn(async () => {});
    await expect(
      prepareAutomaticRelease({ ...bump, existingTagRevision: 'other', published: true }, create),
    ).rejects.toThrow(/another commit/);
    expect(create).not.toHaveBeenCalled();
  });

  it('stops if tag creation fails instead of proceeding with publication', async () => {
    const create = vi.fn(async () => {
      throw new Error('HTTP 422: competing tag');
    });
    await expect(prepareAutomaticRelease(bump, create)).rejects.toThrow(/competing tag/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['0.9.0', '0.8.99', '0.9.2-beta.1', 'invalid'])(
    'rejects a downgrade or invalid version %s',
    (version) => {
      expect(() => planRelease({ ...bump, version })).toThrow();
    },
  );

  it.each(['0.10.0', '1.0.0', '10.0.0'])(
    'compares increasing versions numerically: %s',
    (version) => {
      expect(planRelease({ ...bump, version })).toBe('create');
    },
  );
});

describe('release event trust', () => {
  const run = {
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_repository: { full_name: 'owner/repo' },
  };
  it('accepts only a successful main push from this repository', () => {
    expect(trustedMainRun({ workflow_run: run }, 'owner/repo')).toBe(true);
  });
  it.each([
    { ...run, conclusion: 'failure' },
    { ...run, conclusion: 'cancelled' },
    { ...run, event: 'pull_request' },
    { ...run, event: 'workflow_dispatch' },
    { ...run, head_branch: 'feature/bump' },
    { ...run, head_repository: { full_name: 'fork/repo' } },
    {},
  ])('rejects an untrusted or unsuccessful trigger: %j', (workflow_run) => {
    expect(trustedMainRun({ workflow_run }, 'owner/repo')).toBe(false);
  });
});
