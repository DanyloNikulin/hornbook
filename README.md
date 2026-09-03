# Hornbook

A **conspect journal** for 1:1 language lessons. Your journal is a folder of JSON files on your
machine; Hornbook is the app that reads and writes it. Several language pairs live side by side.
Recordings and cloud models are optional: with whisper.cpp and Ollama it runs at zero cost.

This is a clean engine. It is **not** a fork of anyone's private lesson archive.

## Install, run, open

```bash
npm install
npm run build
npm run serve      # http://127.0.0.1:8787
```

That is the whole product: one server on your machine serving the UI and an API over your
journal folder. For development, `npm start` runs the server next to the Angular dev server on
http://localhost:4200 with `/api` proxied.

The journal lives in `./journal` by default (the repo ships a small demo journal with a Spanish
and an Italian pair). Point `HORNBOOK_JOURNAL` at your own folder:

```bash
HORNBOOK_JOURNAL=~/Hornbook npm run serve
```

Nothing you do in the app goes through git. Back up by copying the folder.

## The journal folder

```
journal/
  journal.config.json        brand, providers, sections[]
  secrets.json               API keys and endpoints entered in Settings (gitignored)
  es-en/                     one section per language pair: <target>-<learner>
    2026-01-01-greetings.json  lesson (source of truth)
    2026-01-01-greetings.md    rendered copy, regenerated on save
    _cheatsheet.json           grammar cheat sheet
    _progress.json             your SM-2 state, quiz scores, activity
    _derived/                  vocab, cards, search index (regenerated, not backed up)
  it-en/
    ...
```

Create a pair on `/setup` in the app (pick target and learner from the catalogue), or add it to
`journal.config.json` → `sections`. A journal in the old single-pair layout (`lessons/` + root
`journal.config.json`) migrates with `npm run migrate`.

## Add a lesson

Everything happens on the **Add** page of a pair:

- **By hand** — title, summary, article; saved as JSON into the pair's folder.
- **From a transcript** — paste it; the extract model writes the article, vocabulary, grammar,
  quotes, quiz and flashcards.
- **From a recording** — drop audio or video; it is transcribed, then extracted. Slides in a
  video are read when the extract model has vision. A live log shows progress.

The cheat sheet page updates itself with "Update from new lessons", and Settings has
"Review topics" for proposing new topic tags. Both need an Anthropic key.

The same things work from the command line:

```bash
npm run lesson:new -- --date 2026-09-02 --title "Greetings" --section es-en
npm run process -- lesson.mp4 --date 2026-09-02 --section es-en     # video: transcribe + slides + extract
npm run process -- notes.txt --from transcript --date 2026-09-02 --section es-en
npm run cheatsheet -- --section es-en
npm run vocab-review -- --section es-en
```

`--section` is optional while the journal has one pair.

## Models

Set them on the Settings page of any pair (⚙ in the header). Journal defaults apply to every
pair; a pair can override them.

| Step | Drivers |
|---|---|
| transcribe | `whisper-cli` (whisper.cpp binary + model file) or `openai` |
| extract | `ollama` (local), `anthropic`, or `openai` |

Keys and endpoints entered in Settings are stored in `journal/secrets.json`, which git ignores.
Values from the environment or a local `.env` are used when the journal has none. Never commit
keys. If the extract model has no vision, slides are skipped.

## Language pair

`target` drives three things: the extraction prompt, browser text-to-speech, and the
typed-answer checker on the flashcards page. The checker forgives a dropped or extra article and
flags a wrong one (gender or number) for targets with an article table: it, es, pt, fr, de, nl,
en, el, ar, he (see `src/lib/articles.ts`). Other targets compare the full typed string.
Gender/number slash variants (`bello/a`, `гарний/а`) work for any target.

Learner-side text is written by the model in `learner`; the UI chrome is English.

## Hosting

Hosting is running the same server on a machine you control, behind a password or an access
proxy: `npm run serve -- --host 0.0.0.0 --port 8787`. A Docker image and a desktop shell are the
next steps in `docs/PLAN.md`.

## Tests

```bash
npm test               # app
npm run test:scripts   # pipeline scripts + server
```
