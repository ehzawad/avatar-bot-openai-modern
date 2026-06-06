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

## Production notes

For local development this is intentionally simple. For production, replace `InMemorySessionStore` with Redis or Postgres, add authentication, add CSRF protections if using cookies, and move CORS origins into environment-specific configuration. The service boundaries are already shaped for that change.
