# Lesson journal

A **conspect journal** for 1:1 language lessons. One pair per site (target = what you study, learner = notes language). JSON is the source of truth. Recordings and cloud APIs are optional.

This is a clean engine. It is **not** a fork of anyone’s private lesson archive.

## Setup

```bash
npm install
# edit journal.config.json AND src/lib/journal.config.json (keep them in sync)
# pair.target / pair.learner are ISO 639-1 codes (es, en, it, uk, ja, …)
npm start        # http://localhost:4200
```

Open `/setup` to pick a pair (downloads a new config file). Open `/compose` to add a conspect.

## Add a lesson

| Door | Command | Cost |
|---|---|---|
| Empty JSON | `npm run lesson:new -- --date 2026-09-02 --title "Greetings"` | $0 |
| Form | `/compose` → Download JSON into `lessons/` | $0 |
| Transcript | `npm run process -- notes.txt --from transcript --date 2026-09-02` | extract API or local LLM |
| Audio | `npm run process -- lesson.m4a --from audio --date 2026-09-02` | transcribe + extract |
| Video | `npm run process -- lesson.mp4 --from video --date 2026-09-02` | + slide frames |

Local drop (this machine only):

```bash
npm run ingest    # 127.0.0.1:8787
npm start         # then /compose
```

## LLM drivers (`journal.config.json` → `providers`)

| Field | Drivers |
|---|---|
| `transcribe` | `openai` (`OPENAI_API_KEY`) or `whisper-cli` (`WHISPER_BIN`, `WHISPER_MODEL`) |
| `extract` | `anthropic` (`ANTHROPIC_API_KEY`), `openai`, or `ollama` (`OLLAMA_HOST`, default `http://127.0.0.1:11434`) |

Copy `.env` keys locally. Never commit them. If extract has no vision, slides are skipped.

Cloudflare R2 + Worker + Actions is an **optional** template under `worker/` — not required.

## Tests

```bash
npm test
npm run test:scripts
```
