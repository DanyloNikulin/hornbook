# Contributing to Hornbook

Hornbook is a local-first application: code belongs in the repository, while
real lesson journals stay on their owners' machines. Contributions are
welcome when they preserve that boundary.

## Before you start

- Search existing issues and discussions before opening a new one.
- Use a `feature/<short-name>` branch for product work.
- Never commit a real journal, recording, transcript, API key, `.env` file,
  `journal/secrets.json`, or anything under `work/`.
- Demo lessons must be fictional and safe to publish.

## Local setup

Hornbook requires Node.js 22.12 or newer and npm 11.

```bash
npm ci
npm run build
npm start
```

Development uses the repository's demo `journal/`. The regular packaged and
browser launchers use `~/Hornbook` unless `HORNBOOK_JOURNAL` is set.

## Checks

Run the checks that cover your change before opening a pull request:

```bash
npm run lint
npm run typecheck:scripts
npm run test:scripts
npm test -- --watch=false
npm run build
npm run harness:api
npm run harness:ui
```

UI changes must be exercised, not only screenshotted. The model-dependent
pipeline and coding-CLI harnesses remain manual because they require local
tools or signed-in CLIs.

## Pull requests

Keep each pull request focused and explain the user-visible outcome. Include
tests for changed behaviour and note any skipped harness step with its reason.
The `gate` status is the branch-protection check: it combines deterministic
checks, browser/API smoke, Docker smoke and packaged desktop walks.

Use short comments only for constraints that are not obvious from the code.
English and Italian interface catalogs must remain in lockstep.
