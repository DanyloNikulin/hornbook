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

5. Commit the release preparation and let the PR gate finish.

## Publish

Create and push the version tag only after the release commit is on `main`:

```bash
git tag -s v0.9.0 -m "Hornbook 0.9.0"
git push origin v0.9.0
```

An unsigned tag may be used until signing is configured, but never move or
reuse a published tag. The `Release` workflow validates the tag against the
package and changelog, repeats deterministic and smoke checks, builds Windows,
macOS and Linux distributions, publishes the multi-architecture GHCR image,
and creates or repairs the GitHub Release from the changelog section.

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
