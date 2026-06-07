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
- Modular frontend: API client, avatar scene, audio player, recorder, and UI view are separate modules.
- Modular backend: routes, domain schemas, application service, session store, and OpenAI adapter are separate modules.

## Run on macOS

```zsh
cd avatar-bot-openai-modern

# If OPENAI_API_KEY is exported from ~/.zshrc, make sure this terminal has loaded it.
source ~/.zshrc
./scripts/run-dev.sh
```

Open:

```text
http://127.0.0.1:8000
```

You can also create a local `.env` from `.env.example` and set `OPENAI_API_KEY` there. The dev script and app both read the same runtime settings.

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

The studio frontend lives in `studio-web/` (React 19 + Vite + TanStack Query + zundo). There are two ways to run it.

**Live dev (Vite dev server + proxy):**

```zsh
# Terminal 1 — backend
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Terminal 2 — studio frontend
cd studio-web
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000`, so all API calls stay root-relative.

**Built (served by FastAPI):**

```zsh
cd studio-web
npm install
npm run build      # tsc + vite, emits studio-web/dist
```

When `studio-web/dist` exists, FastAPI mounts it at `/studio` (before the root avatar mount). Start the backend with `uvicorn app.main:app --host 127.0.0.1 --port 8000` and open:

```text
http://127.0.0.1:8000/studio
```

### Model tiers

Transcription tier is resolved server-side (the backend never trusts a raw model string from the client):

| tier      | model string             | notes                          |
|-----------|--------------------------|--------------------------------|
| `fast`    | `gpt-4o-mini-transcribe` | quick, lower cost              |
| `best`    | `gpt-4o-transcribe`      | **default** (eval quality)     |
| `whisper` | `whisper-1`              | segment timestamps             |

Transcription always sends `language` (default `bn`, override `bn | auto | en`), `temperature=0`, and a versioned Bengali prompt (default `bn-codeswitch-v1`). Override the tier model strings via `OPENAI_TRANSCRIBE_MODEL_FAST`, `OPENAI_TRANSCRIBE_MODEL_BEST`, and `OPENAI_TRANSCRIBE_MODEL_WHISPER`.

### Where data lives

The SQLite DB and recorded audio live under `data/` (created at runtime), never under any static directory and never web-served:

- `data/studio.db` — source of truth (series, datasets/pages, lines, revisions, snapshots).
- `data/audio/` — captured audio (`<sha>.webm`), retained for retry.

`data/` is gitignored (along with `studio-web/node_modules/` and `studio-web/dist/`). Override the location with `DATA_DIR`.

### Downloads

Each page downloads as either:

- **`.txt`** — one line per non-deleted line; `annotated=true` prefixes each line with `[role] `.
- **`.jsonl`** — grouped by `conversation_key` into `{messages, expected, metadata}` examples. Default `scope=accepted` exports only accepted lines; `scope=all` exports all non-deleted lines.

## Production notes

For local development this is intentionally simple. For production, replace `InMemorySessionStore` with Redis or Postgres, add authentication, add CSRF protections if using cookies, and move CORS origins into environment-specific configuration. The service boundaries are already shaped for that change.
