# Changelog

All notable changes to Hornbook.

## Unreleased

- Nothing yet.

## 0.9.0 — 2026-09-04

Product preview: the complete local-first lesson workflow is packaged for
desktop and Docker, with transfer tools and an automated release path. This
is deliberately 0.9; the next phase is hardening and refactoring before 1.0.

- Version tags now run a reproducible release workflow: package metadata and
  changelog validation, full deterministic and smoke checks, tested Windows,
  macOS and Linux distributions, checksums, a GitHub Release, and versioned
  multi-architecture images on GitHub Container Registry.
- The pull-request gate now includes API, browser, Docker and packaged desktop
  walks. The Docker image runs as an unprivileged user and exposes a health
  check while keeping the journal on its volume.
- Added contribution, support and security policies, structured issue forms,
  a pull-request checklist, CODEOWNERS, Dependabot and consistent text-file
  attributes. GitHub Discussions and private vulnerability reports are on.
- Lessons export as canonical JSON and import through an explicit Add tab.
  Conflicts stop before writing and offer keep-both with a new slug or replace.
  Whole language pairs move as ZIP archives with lessons, sheet, topics,
  theme and backdrop, plus optional study progress; `_derived/` is rebuilt.
  Lesson, vocabulary and card ids are now lesson-scoped, with old SM-2 card
  progress mapped forward on read.
- Native Electron shell: one-instance window, tray lifecycle, remembered
  size, journal and tool pickers, startup setting, native job notifications,
  and a random-port local server protected by a per-launch token.
- Daily GitHub release checks show the same update banner in desktop and
  source-clone runs. Packaged apps download in the background and install
  only after “Restart to update”; managed local tools flag pin changes.
- The server and job scripts compile to plain JavaScript for packaging.
  Frame hashes now use ffmpeg's 8×8 grayscale output, leaving no native Node
  modules in the production app.
- Electron Builder targets Windows NSIS and portable apps, macOS DMG/zip,
  and Linux AppImage/deb, with release-time signing/notarisation. The PR gate
  walks the packaged app on all three platforms against a fake release feed.
- Topics are journal data: an optional `_topics.json` per section holds the
  cheat-sheet categories and the topics with their categories and tagger
  patterns; the six bundled topics are the default. "Review topics" appends
  to that file and writes its report next to it instead of editing source.
- Setup inside the app: a Local tools section on Application settings shows
  ffmpeg, whisper.cpp, a whisper model, Ollama and a writing model, each
  installed or not, with a download that is planned (source, size, SHA-256)
  before it starts and verified after, or the package-manager line. One
  button fetches what is missing. A managed Ollama runs as a child of the
  server. `hornbook doctor` prints the same table.
- Only the named demo lessons are tracked in the repository journal.

## 0.1.0 — 2026-09-04

First public version. A conspect journal for 1:1 language lessons that runs
on your own machine: the journal is a folder of JSON files, a Node server
serves the Angular UI and an API over that folder, and the pipeline that
turns a recording into a conspect runs inside the server as jobs.

### The journal

- The folder is the database: `journal.config.json`, one sub-folder per
  language pair (`<target>-<learner>`), lesson JSON as the source of truth,
  a rendered markdown copy, the cheat sheet, and `_progress.json` with
  SM-2 state, quiz scores and activity. Derived data (`_derived/`) is
  regenerated and not backed up.
- Several language pairs side by side, created on `/setup` from a
  catalogue of about 40 languages, with progress isolated per pair.
- `npm run migrate` moves a single-pair journal in the old layout.

### The app

- Lessons, glossary, flashcards with typed answers and an article-aware
  checker, quiz (multiple choice, fill, translate), search, cheat sheet,
  and an Add page that takes a hand-written lesson, a pasted transcript, or
  an audio or video file.
- Jobs run one at a time inside the server with a live log; the lesson
  opens when the job ends. The cheat sheet updates from new lessons and
  Settings can propose new topic tags.
- Interface in English or Italian, chosen on Application settings.
- Per-pair look: six colour presets defined for day and night, three
  display fonts, and an optional backdrop photo served from the pair's
  folder.

### The pipeline

- Two steps, hear and write, each run in one place: this computer, the
  home network (Ollama), or an internet API. A readiness probe per step
  lists what the connection offers.
- Hearing: `whisper-cli` (whisper.cpp) or OpenAI. Writing: Ollama,
  Anthropic, OpenAI, or a coding CLI already signed in on this computer
  (Claude Code, Codex, Grok, Kimi), which stores no key.
- Zero-cost path verified end to end on a 10-minute and a 15-minute
  lesson video with whisper.cpp and `qwen2.5:7b`. Small local models get
  field aliases, one repair round, and salvage of empty vocabulary and
  junk quotes before validation.
- Slides in a video are read when the writing model has vision.

### Packaging

- `npm run hornbook` starts the server on 127.0.0.1 and opens the browser;
  first run creates `~/Hornbook` from the demo journal. `--app` opens a
  chromeless window in an installed Chromium browser.
- Hosted mode: `--host 0.0.0.0 --password …` puts HTTP Basic auth on
  every request; a Dockerfile builds the same server with ffmpeg.
- Fonts and a flag-emoji subset are bundled; the app makes no network
  requests of its own.

### Testing

- Unit suites for the app, the scripts and the server, run by the PR gate.
- A local harness: API smoke, zero-cost pipeline on a 24-second fixture
  with four real slides, a Playwright browser walk, and a run through every
  coding CLI found on the machine.

### Deferred after 0.1

Packaged installers and release automation arrive with 0.9.0. Further
hardening and release verification remain planned for 1.0.
