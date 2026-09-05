# Releasing Hornbook

Hornbook releases are immutable tags built by GitHub Actions. Do not upload a
locally built installer: the tag workflow is the source of every desktop
artifact, Docker image and release note.

## Prepare

1. Start from a clean `main` whose `gate` check is green.
2. Set the same stable semantic version in `package.json` and
   `package-lock.json`.
3. Move finished notes from `Unreleased` into a dated version section in
   `CHANGELOG.md`.
4. Run the release checks:

   ```bash
   npm ci
   npm run release:check -- --tag v0.9.0
   npm run lint
   npm run typecheck:scripts
   npm run test:scripts
   npm test -- --watch=false
   npm run build
   npm run harness:api
   npm run harness:ui
   ```

5. Commit the release preparation, let the PR gate finish, and merge into `main`.

## Publish

Publishing is automatic. When the `PR gate` workflow succeeds for a push to
`main`, `Release` checks the verified commit against the current main head.
If its package version has not been published and is newer than the other
version tags reachable from that commit, it validates the lockfile and dated
changelog, creates `v<version>`, and builds and publishes
the release in the same workflow. No manual tag or extra token is needed.

Ordinary merges of an already published version and superseded main runs are skipped.
The latest successful main run still picks up an untagged version if its bump
was in an earlier commit, including when newer queued runs replace older ones.
An existing tag is never moved: a conflicting tag requires a new version.
Re-running the same verified release commit can resume an unpublished tag;
an already published version is skipped. Release runs are serialized.

The first automation-only merge keeps version 0.9.1 and publishes nothing;
the next release PR should increase the version and add its dated notes.

Manual tags remain supported. For an explicit release, create and push its tag
only after the release commit is on `main`:

```bash
git tag -s v0.9.0 -m "Hornbook 0.9.0"
git push origin v0.9.0
```

Automatic tags are unsigned; manually signed tags remain supported. Never
move or reuse a published tag. The `Release` workflow validates the tag against the
package and changelog, repeats deterministic and smoke checks, builds Windows,
macOS and Linux distributions, publishes the multi-architecture GHCR image,
and creates or repairs the GitHub Release from the changelog section.

To retry a failed release, re-run its failed jobs in Actions, or dispatch
`Release` manually with the existing tag. An explicit dispatch also supports
repairing artifacts for an existing release; it does not update Docker `latest`.

Versions below 1.0 are published as GitHub pre-releases and only receive a
versioned Docker tag. Stable releases also update the Docker `latest` tag.

## Signing secrets

Unsigned preview artifacts build without repository secrets. Signed releases
use these optional GitHub Actions secrets:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Windows Trusted Signing: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`,
  `AZURE_TRUSTED_SIGNING_ACCOUNT`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`.

Never put signing material or API keys in the repository, workflow files,
artifacts or journals.
