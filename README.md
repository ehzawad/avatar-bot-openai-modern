# Aria OpenAI Avatar — modular rewrite

This is a complete OpenAI-only rewrite of the original Avatar-bot idea.

The browser owns rendering, audio playback, lip-sync, microphone capture, and UI state. The Python backend owns all OpenAI calls. The API key is never stored in localStorage and never sent to the browser.

## What changed

- One provider boundary: `app/services/openai_gateway.py`.
- Responses API for structured avatar replies.
- JSON Schema structured output instead of `[face:tag]` regex parsing.
- OpenAI speech endpoint for text-to-speech.
- OpenAI transcription endpoint for browser-recorded voice input.
- Live interview mode that listens for speech, detects a pause, then replies aloud and resumes listening.
- Server-side in-memory conversation sessions using `previous_response_id` for continuity.
- Unified frontend: a single Vite + React + TypeScript app in `web/` serves **both** the avatar
  (at `/`) and the Bengali Eval Studio (at `/studio`).
- Modular backend: routes, domain schemas, application service, session store, and OpenAI adapter are separate modules.

## Unified frontend (`web/`)

There is now **one** frontend app: `web/` (Vite + React + TypeScript). It contains both surfaces
behind a single React Router, code-split into lazy chunks:

- `/` — the avatar app (Three.js / VRM scene, voice loop, live interview mode).
- `/studio` — the Bengali Conversational Eval Studio.

FastAPI serves the single built SPA from `web/dist`: API routes are matched first, hashed assets
are served from `/assets/*`, and any other path falls back to `index.html` so client-side routes
(including a hard reload of `/studio`) resolve. The Three.js / `@pixiv/three-vrm` code lives only
under `web/src/features/avatar/**` and is lazy-loaded, so the `/studio` chunk never pulls Three.

> **`frontend/` and `studio-web/` are retired.** They have been replaced by `web/`. The legacy
> avatar app (`frontend/`) and the standalone studio app (`studio-web/`) are no longer the way to
> run or build this project; use `web/` for everything. See
> [docs/WEB_ARCHITECTURE.md](docs/WEB_ARCHITECTURE.md) for the unified frontend design.

## Run on macOS

> **Python env note.** `uvicorn` is installed in the project virtualenv at `.venv/`, not in your
> system Python. Activate the venv (or prefix the binary) before running the backend, otherwise
> you get `No module named uvicorn`:
> ```zsh
> source .venv/bin/activate    # then `uvicorn ...` / `python ...` work directly
> # — or without activating —
> .venv/bin/uvicorn app.main:app ...
> uv run uvicorn app.main:app ...     # if you use uv
> ```
> First-time setup (creates `.venv` and installs deps): `./scripts/run-dev.sh`, or
> `uv venv && uv pip install -r requirements.txt`. Also set `OPENAI_API_KEY` before starting.
> Only the **backend** needs the venv; the `web/` frontend is Node, not Python.

Set `OPENAI_API_KEY` before starting (export it, or copy `.env.example` to `.env` and set it
there — the dev script and the app read the same runtime settings).

### Dev — two terminals (Vite dev server + proxy)

```zsh
# Terminal 1 — backend (Python venv)
source .venv/bin/activate && uvicorn app.main:app --reload --port 8000

# Terminal 2 — unified frontend (Node; no venv needed)
cd web && npm install && npm run dev
```

Open the **Vite** URL it prints (e.g. `http://localhost:5173/`), not port 8000, in dev mode. The
Vite dev server proxies `/api` to `http://127.0.0.1:8000`, so all API calls stay root-relative.
`/` is the avatar, `/studio` is the studio.

### Prod — one URL served by FastAPI

```zsh
# 1. build the unified frontend once (re-run after frontend changes)
cd web && npm install && npm run build      # tsc -b + vite build, emits web/dist

# 2. run the backend (serves the API AND the built SPA from web/dist)
source .venv/bin/activate && uvicorn app.main:app --port 8000
```

Open:

```text
http://127.0.0.1:8000/              # the avatar app
http://127.0.0.1:8000/studio        # the Bengali Eval Studio
```

## Optional model overrides

```zsh
export OPENAI_RESPONSE_MODEL='gpt-5.4-mini'
export OPENAI_TTS_MODEL='gpt-4o-mini-tts'
export OPENAI_TRANSCRIBE_MODEL='gpt-4o-mini-transcribe'
export OPENAI_TTS_VOICE='alloy'
```

The default response model is `gpt-5.4-mini` to keep latency/cost reasonable while staying on the latest GPT family documented by OpenAI. Use `gpt-5.5` if you want the flagship model and accept higher cost/latency.

## Live interview mode

The `Live` control turns the microphone into a pause-detected interview loop. Aria listens, sends the user's turn after a short silence, speaks the reply, then resumes listening after playback ends.

See [docs/LIVE_INTERVIEW_MODE.md](docs/LIVE_INTERVIEW_MODE.md) for the runtime flow and tuning points.

For visual system maps and request-flow diagrams, see [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md).

## API surface

```text
GET    /api/health
GET    /api/config
POST   /api/conversations
GET    /api/conversations/{conversation_id}
DELETE /api/conversations/{conversation_id}
POST   /api/conversations/{conversation_id}/messages
POST   /api/speech/transcriptions
```

## Architecture

The unified `web/` app is a single Vite + React + TS SPA with a React Router that lazy-loads two
feature areas (`features/avatar`, `features/studio`) over a shared `lib/` boundary (HTTP client,
TanStack Query hooks, shared recorder). FastAPI serves the one `web/dist` build for all non-API
routes. See [docs/WEB_ARCHITECTURE.md](docs/WEB_ARCHITECTURE.md) for the full frontend design and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the backend module map.

```text
Browser UI
  -> /api/conversations/{id}/messages
     -> AvatarConversationService
        -> OpenAIGateway.create_avatar_reply()  -> POST /v1/responses
        -> OpenAIGateway.create_speech()        -> POST /v1/audio/speech
        -> InMemorySessionStore stores last response id
  <- structured reply + base64 audio
  -> AudioContext + analyser drives mouth movement

Browser microphone
  -> MediaRecorder blob
  -> /api/speech/transcriptions
     -> OpenAIGateway.transcribe()              -> POST /v1/audio/transcriptions
  <- transcript
  -> normal message flow
```

## Bengali Conversational Eval Studio

The studio is a voice-first tool for building a **Bengali conversational eval dataset**. The loop is Record → Stop → transcribe (Bengali) → append the transcript as a new line on the active "page". Pages are shown as cards, auto-roll to a new page when full, and each page has an interactive line editor, durable rollback, and `.txt` / `.jsonl` downloads.

It is additive to the avatar app: the existing avatar at `/` keeps working, OpenAI access stays direct `httpx` (no SDK), and all studio code lives in a new `datasets` router plus a `dataset_store` service. The frozen contract is [docs/STUDIO_CONTRACT.md](docs/STUDIO_CONTRACT.md); a focused guide is [docs/EVAL_STUDIO.md](docs/EVAL_STUDIO.md).

### How to run

The studio is part of the unified `web/` app and is served at `/studio`. Run it exactly like the
rest of the app — see [Run on macOS](#run-on-macos) above:

- **Dev:** two terminals (backend via `.venv`; `cd web && npm install && npm run dev`), then open
  the Vite URL at `/studio`.
- **Prod:** `cd web && npm install && npm run build`, run uvicorn, open
  `http://127.0.0.1:8000/studio`.

(The standalone `studio-web/` app is retired — it has been folded into `web/`.)

### Model tiers

Transcription tier is resolved server-side (the backend never trusts a raw model string from the client):

| tier      | model string             | notes                          |
|-----------|--------------------------|--------------------------------|
| `fast`    | `gpt-4o-mini-transcribe`   | quick, lower cost              |
| `best`    | `gpt-4o-transcribe`        | **default** (eval quality, Bengali script) |
| `diarize` | `gpt-4o-transcribe-diarize`| speaker-aware (multi-speaker); note: no prompt support, so it romanizes Bengali |

`fast`/`best` always send `language` (default `bn`, override `bn | auto | en`), `temperature=0`, a versioned Bengali prompt (default `bn-codeswitch-v1`), and request logprobs for QC. The `diarize` model has a restricted parameter surface (it rejects `prompt`/`include[]`), so it is sent `language` + `temperature` only — great for separating speakers, but it transcribes Bengali in Latin script; prefer `best` for Bengali-script eval text. Override the tier model strings via `OPENAI_TRANSCRIBE_MODEL_FAST`, `OPENAI_TRANSCRIBE_MODEL_BEST`, and `OPENAI_TRANSCRIBE_MODEL_DIARIZE`.

### Where data lives

The SQLite DB and recorded audio live under `data/` (created at runtime), never under any static directory and never web-served:

- `data/studio.db` — source of truth (series, datasets/pages, lines, revisions, snapshots).
- `data/audio/` — captured audio (`<sha>.webm`), retained for retry.

`data/` is gitignored (along with `web/node_modules/` and `web/dist/`). Override the location with `DATA_DIR`.

### Per-line tag

Each line carries an optional, nullable `tag` (a free-text label, e.g. `greeting`). It is sticky
in the record bar (the current tag is applied to every capture) and editable per row in the line
editor. Empty or whitespace-only input is stored as `NULL`. The tag is snapshotted with the line,
so it survives rollback, and it is the source of the `tagname` column in the CSV export.

### Downloads

Each page downloads as one of:

- **`.txt`** — one line per non-deleted line; `annotated=true` prefixes each line with `[role] `.
- **`.jsonl`** — grouped by `conversation_key` into `{messages, expected, metadata}` examples. Default `scope=accepted` exports only accepted lines; `scope=all` exports all non-deleted lines.
- **`.csv`** — a flat `text,tagname` table for spreadsheet/labeling tools.

The CSV is `text/csv; charset=utf-8` with a header row `text,tagname` followed by one row per
non-deleted line in `line_index` order. It is **RFC-4180 quoted**: every field is wrapped in
double quotes and any embedded `"` is doubled (`""`); a null tag becomes an empty quoted field
`""`. UTF-8 (Bengali) text is preserved. `scope` works like the txt/jsonl downloads (`all` is the
default, `accepted` exports only accepted lines). Example:

```csv
text,tagname
"আজ তুমি কেমন আছো?","greeting"
"আমি ভালো আছি, ""সত্যিই""।",""
```

## Production notes

For local development this is intentionally simple. For production, replace `InMemorySessionStore` with Redis or Postgres, add authentication, add CSRF protections if using cookies, and move CORS origins into environment-specific configuration. The service boundaries are already shaped for that change.
