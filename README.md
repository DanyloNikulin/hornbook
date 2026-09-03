# Hornbook

A **conspect journal** for 1:1 language lessons. Your journal is a folder of JSON files on your
machine; Hornbook is the app that reads and writes it. Several language pairs live side by side as
**sections**. Recordings and cloud APIs are optional.

This is a clean engine. It is **not** a fork of anyone's private lesson archive.

## Run it

```bash
npm install
npm start          # server on 127.0.0.1:8787 + UI on http://localhost:4200
```

`npm start` runs the Hornbook server (API over the journal folder) and the Angular dev server,
which proxies `/api` to it. For a single-process run, build first:

```bash
npm run build
npm run serve      # serves the built UI and the API from 127.0.0.1:8787
```

The journal lives in `./journal` by default (the repo ships a small demo journal). Point
`HORNBOOK_JOURNAL` at another folder to use your own:

```bash
HORNBOOK_JOURNAL=~/Hornbook npm run serve
```

## The journal folder

```
journal/
  journal.config.json        brand, providers, sections[]
  es-en/                     one section per language pair: <target>-<learner>
    2026-01-01-greetings.json  lesson (source of truth)
    2026-01-01-greetings.md    rendered copy, regenerated on save
    _cheatsheet.json           grammar cheat sheet
    _progress.json             your SM-2 state, quiz scores, activity
    _derived/                  vocab, cards, search index (regenerated, not backed up)
  it-en/
    ...
```

Back up by copying the folder. Create a pair on `/setup` in the app, or add it to
`journal.config.json` → `sections`. A journal in the old single-pair layout (`lessons/` +
root `journal.config.json`) migrates with `npm run migrate`.

## Add a lesson

| Door | How | Cost |
|---|---|---|
| Form | `/compose` in the app → Save | $0 |
| Empty JSON | `npm run lesson:new -- --date 2026-09-02 --title "Greetings" --section es-en` | $0 |
| Transcript | drop a `.txt` on `/compose`, or `npm run process -- notes.txt --from transcript --date 2026-09-02 --section es-en` | extract API or local LLM |
| Audio | `npm run process -- lesson.m4a --from audio --date 2026-09-02 --section es-en` | transcribe + extract |
| Video | `npm run process -- lesson.mp4 --from video --date 2026-09-02 --section es-en` | + slide frames |

`--section` is optional while the journal has one section.

## LLM drivers (`journal.config.json` → `providers`)

| Field | Drivers |
|---|---|
| `transcribe` | `openai` (`OPENAI_API_KEY`) or `whisper-cli` (`WHISPER_BIN`, `WHISPER_MODEL`) |
| `extract` | `anthropic` (`ANTHROPIC_API_KEY`), `openai`, or `ollama` (`OLLAMA_HOST`, default `http://127.0.0.1:11434`) |

A section can override `providers` for itself. Copy `.env` keys locally. Never commit them. If
extract has no vision, slides are skipped.

## Language pair

`target` drives three things: the extraction prompt, browser text-to-speech, and the
typed-answer checker on `/flashcards`. The checker forgives a dropped/extra article and flags a
wrong one (gender or number) for targets with an article table — it, es, pt, fr, de, nl, en, el,
ar, he (see `src/lib/articles.ts`). Other targets compare the full typed string. Gender/number
slash variants (`bello/a`, `гарний/а`) work for any target.

Learner-side text is written by the model in `learner`; the UI chrome is English.

## Tests

```bash
npm test
npm run test:scripts   # pipeline scripts + server
```

The Cloudflare R2 + Worker + Actions pipeline under `worker/` is a leftover template and is being
retired (see `docs/PLAN.md`).
