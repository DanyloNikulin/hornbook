# Local harness

Four scripts that exercise the running application the way a person would,
against throwaway data, without a paid API. They complement the unit suites
(`npm test`, `npm run test:scripts`) and are run by hand or by a tester agent,
not by the PR gate.

Every script starts its own server on `127.0.0.1` with the cloud keys blanked,
on a fresh journal under `work/harness/journals/`. The repo's `journal/` and
`~/Hornbook` are never written. Results are printed as `PASS` / `FAIL` /
`SKIP` lines and saved as `work/harness/<name>.json`; the browser walk also
saves screenshots under `work/harness/screens/`. `SKIP` means a tool or model
is not present on this machine, never that something is wrong.

| Script | Command | Needs | Time |
|---|---|---|---|
| API smoke | `npm run harness:api` | nothing (Ollama and whisper.cpp are optional) | ~30 s |
| Zero-cost pipeline | `npm run harness:pipeline` | ffmpeg; whisper.cpp; Ollama with a text model and, for slides, a vision model | 5–15 min |
| Browser walk | `npm run harness:ui` | `npm run build` first; Chrome or Edge installed | ~1 min |
| Coding CLIs | `npm run harness:cli` | `npm run build` first; any of Claude Code, Codex, Grok, Kimi installed and signed in | 1–4 min per CLI |

## API smoke

Walks every endpoint the UI uses over a copy of the demo journal: config,
settings, lessons, derived data, progress round trip, the readiness probe in
its four states (ready, pick a model, plain failure, bad request), a
throwaway `ja-en` pair with a hand-written lesson, and the job runner. The
extract model is set to a name that cannot exist, so the cheat-sheet job is
proven to fail cleanly rather than hang. With Ollama reachable the probe's
model list is checked as well; with `WHISPER_BIN` and `WHISPER_MODEL` set the
whisper probe runs against the real files.

## Zero-cost pipeline

Uses `harness/fixtures/lesson.mp4`: 24 seconds of a synthetic voice over
four real slides with text (regenerate with `npm run harness:fixture`, which
renders the slides with sharp and speaks the intro with the OS voice). Steps,
each skipped with a reason when its tool is missing:

1. ffmpeg samples frames and the average-hash dedupe keeps each slide once.
2. whisper.cpp hears the audio.
3. A throwaway journal is served with whisper-cli + Ollama as its providers.
4. Jobs through the API: a JSON copy (no model), a pasted transcript, the
   video with a text-only model (slides skipped, the log says so, and no
   slide is invented), the video with a vision model (the lesson must
   contain at least one slide read from the frames), a cheat-sheet rebuild
   and a topic review.

Environment: `WHISPER_BIN`, `WHISPER_MODEL` (whisper.cpp binary and ggml
file), `OLLAMA_HOST` (default `http://127.0.0.1:11434`),
`HORNBOOK_EXTRACT_MODEL` (default `qwen2.5:7b`), `HORNBOOK_VISION_MODEL`
(default `gemma3:4b`). Each lesson the models write is validated against the
lesson schema; the content itself is not judged.

## Browser walk

Playwright (`playwright-core`, no browser download) drives the installed
Chrome or Edge through the built app: home, setup catalogue, application
settings including the interface language, both pipeline probes and the
coding-CLI place for writing (the four chips, the `-` model, a Codex probe
that is green when the CLI is on PATH and a red "Not yet." when not), the
Spanish pair (lesson, quiz with every item answered and graded, glossary,
flashcards, search, cheat sheet, Add, pair settings), the Italian pair, the
pair switcher, both not-found pages, day/night, creating a pair and saving a
lesson by hand, and the mobile menu. It also confirms the bundled flag font
loaded, which is what keeps Windows from showing "ES" instead of a flag.

`HORNBOOK_BROWSER` picks the channel (`chrome`, `msedge`, `chromium`).
`HORNBOOK_UI=http://localhost:4200` walks a dev server you already run
instead (with `HORNBOOK_API` for its server, default `http://127.0.0.1:8787`);
the throwaway pair is then deleted through that API.

## Coding CLIs

For each of `claude`, `codex`, `grok` and `kimi` found on PATH (or named in
`CLAUDE_BIN` and friends): a throwaway journal with writing set to that CLI,
the readiness probe, `harness/fixtures/transcript.txt` through the job
runner, the lesson validated against the schema with the quote checks, then
that lesson's quiz taken wrong and right and one flashcard typed in the
browser. The CLI's own sign-in is used; nothing is entered. A CLI that is
not installed is a `SKIP`; one that is installed and fails is a `FAIL`, with
the job log in `work/harness/cli/<cli>/job-log.txt` and the lesson next to
it.

`HORNBOOK_CLI=kimi,claude` limits the run; `HORNBOOK_CLI_MODEL` names a
model (default `-`, the model the CLI is set to).

## Brief for a tester agent

Copy from here when handing the harness to another agent.

> You are testing Hornbook, a local lesson-journal app (Node server + Angular
> UI over a folder of JSON). Work in the repo checkout you are given. Do not
> commit, do not push, do not edit files under `src/`, `server/` or `scripts/`;
> your deliverable is a report. Never enter or use a paid API key: the harness
> blanks cloud keys and you must not add any. Do not touch `~/Hornbook` or the
> repo's `journal/` folder; the harness writes only under `work/harness/`.
>
> Setup: `npm install`, then `npm run build`. Check the tools: `ffmpeg
> -version`; `curl http://127.0.0.1:11434/api/tags` should list `qwen2.5:7b`
> and `gemma3:4b` (pull them with `ollama pull` if missing and Ollama is
> installed); a whisper.cpp build with `whisper-cli` and a `ggml-tiny.bin` or
> larger model. Put the two whisper paths in `WHISPER_BIN` and `WHISPER_MODEL`.
>
> Run, in this order, and keep the full output of each:
> 1. `npm run test:scripts` and `npm test -- --watch=false` (unit suites; all green is the baseline).
> 2. `npm run harness:api`
> 3. `npm run harness:pipeline` (allow up to 15 minutes; it is slow, not stuck, while a job shows `running`)
> 4. `npm run harness:ui`
> 5. `npm run harness:cli` (only the coding CLIs installed and signed in on the machine run; a few minutes each)
>
> Read `harness/README.md` for what each step checks. `SKIP` lines are
> expected when a tool is missing; say which ones you saw and why. A `FAIL`
> is a finding: quote the line, the detail after the dash, and the matching
> part of `work/harness/<name>.json` (it holds the last server log lines and
> the job logs). Look at the screenshots in `work/harness/screens/`; in
> `01-home.png` and `02-setup.png` the language pairs must show flag images,
> not letter pairs like "ES", and in `05-settings-probe.png` the text under
> "Find models" must be grey ("Connected. … Pick one of N pulled model(s).")
> with model chips above it, not red.
>
> Then use the app yourself for ten minutes: `npm run hornbook -- --journal
> work/harness/journals/manual --port 8795 --no-open` and open
> http://127.0.0.1:8795. Create a pair, add a lesson from
> `harness/fixtures/transcript.txt` on the Add page with the Ollama model
> picked in Application settings, take the quiz, review flashcards, search,
> switch the interface to Italiano and back, toggle night mode. Note anything
> that is wrong, slow, confusing or inconsistent between English and Italian
> chrome, with the exact page and what you expected.
>
> Report format: a short verdict first (ship / not yet, and why), then a table
> of the four runs with passed / failed / skipped counts, then findings ordered
> by severity, each with steps to reproduce, then the skips. Do not restate
> passing checks. Attach nothing from `~/Hornbook`.
