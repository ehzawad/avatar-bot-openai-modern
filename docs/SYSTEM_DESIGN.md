# System Design Diagrams

This document is the visual map for Aria. It uses plain ASCII diagrams for quick terminal reading and Mermaid diagrams for renderable views on GitHub and other Markdown viewers.

## Mental Model

Aria is a turn-taking voice avatar. The browser owns the live human interface. The backend owns OpenAI calls and secrets. OpenAI owns model generation, speech-to-text, and text-to-speech.

```text
Human
  |
  | click, type, speak, pause
  v
Browser UI
  |
  | HTTPS to local FastAPI app
  v
Backend
  |
  | HTTPS to OpenAI, server-side key only
  v
OpenAI APIs
```

```mermaid
flowchart LR
  human[Human user]
  browser[Browser UI\nThree.js avatar, mic, audio, chat state]
  backend[FastAPI backend\nroutes, orchestration, sessions]
  openai[OpenAI APIs\nResponses, speech, transcription]

  human -->|speak, type, click| browser
  browser -->|REST requests, no API key| backend
  backend -->|server-side OPENAI_API_KEY| openai
  openai -->|JSON reply, transcript, audio bytes| backend
  backend -->|structured reply and audio data URL| browser
  browser -->|avatar motion, lip sync, spoken reply| human
```

## Runtime Topology

The app is one FastAPI process serving both the API and the static frontend.

```text
Process: python -m uvicorn app.main:app --reload

127.0.0.1:8000
|
+-- GET  /                         -> frontend/index.html
+-- GET  /src/*                    -> frontend modules
+-- GET  /assets/*                 -> CSS/assets
+-- GET  /api/health               -> config health
+-- GET  /api/config               -> public runtime config
+-- POST /api/conversations        -> create local session
+-- POST /api/conversations/:id/messages
|                                      -> OpenAI Responses + TTS
+-- POST /api/speech/transcriptions
                                       -> OpenAI transcription
```

```mermaid
flowchart TB
  subgraph uvicorn[Uvicorn process]
    appmain[app.main:create_app]
    static[StaticFiles frontend/]
    api[API router /api]
    state[app.state\nsettings, session_store, openai_gateway, avatar_service]
  end

  browser[Browser]
  browser -->|GET /| static
  browser -->|GET /src/* /assets/*| static
  browser -->|GET/POST /api/*| api
  appmain --> static
  appmain --> api
  appmain --> state
```

## Frontend Module Map

The browser side is split by responsibility. `frontend/src/app.js` composes everything but does not own rendering, API details, or audio internals.

```text
frontend/src/app.js
|
+-- api/client.js
|     owns fetch calls to FastAPI
|
+-- core/state.js
|     owns conversation id, selected voice, busy, live mode
|
+-- ui/dom.js + ui/chatView.js
|     owns DOM references and visible UI updates
|
+-- audio/recorder.js
|     owns microphone capture, RMS level, silence pause detection
|
+-- audio/player.js
|     owns TTS playback and analyser output for mouth movement
|
+-- avatar/avatarScene.js
      owns Three.js scene, camera, gestures, idle animation
      |
      +-- avatar/modelLoader.js
      +-- avatar/expressionController.js
```

```mermaid
flowchart LR
  appjs[app.js\ncomposition glue]
  api[api/client.js]
  state[core/state.js]
  dom[ui/dom.js]
  view[ui/chatView.js]
  recorder[audio/recorder.js]
  player[audio/player.js]
  scene[avatar/avatarScene.js]
  loader[avatar/modelLoader.js]
  expressions[avatar/expressionController.js]

  appjs --> api
  appjs --> state
  appjs --> dom
  appjs --> view
  appjs --> recorder
  appjs --> player
  appjs --> scene
  scene --> loader
  scene --> expressions
  scene --> player
```

## Backend Module Map

The backend keeps HTTP, domain contracts, OpenAI transport, and orchestration separate.

```text
app/main.py
|
+-- app/api/router.py
|     |
|     +-- routes/health.py
|     +-- routes/conversations.py
|     +-- routes/speech.py
|
+-- app/api/dependencies.py
|     reads app.state dependencies
|
+-- app/domain/schemas.py
|     Pydantic request/response contracts
|
+-- app/domain/prompts.py
|     avatar and live-interview instructions
|
+-- app/services/orchestrator.py
|     one message turn = response + speech + session append
|
+-- app/services/openai_gateway.py
|     direct HTTP adapter for OpenAI endpoints
|
+-- app/services/session_store.py
      in-memory conversation state and last response id
```

```mermaid
flowchart TB
  main[app/main.py]
  router[api/router.py]
  routes[api/routes/*]
  deps[api/dependencies.py]
  schemas[domain/schemas.py]
  prompts[domain/prompts.py]
  service[services/orchestrator.py]
  gateway[services/openai_gateway.py]
  sessions[services/session_store.py]
  openai[OpenAI APIs]

  main --> router
  router --> routes
  routes --> deps
  routes --> schemas
  routes --> service
  service --> sessions
  service --> gateway
  gateway --> prompts
  gateway --> openai
```

## Typed Message Turn

A typed turn is the simplest flow. It still produces speech and avatar animation.

```text
User types
  |
  v
app.js sendMessage()
  |
  | POST /api/conversations/:id/messages
  | body: { message, voice, interaction_mode: "chat" }
  v
FastAPI route
  |
  v
AvatarConversationService
  |
  +--> OpenAI Responses API -> structured reply JSON
  |
  +--> OpenAI speech API -> mp3 bytes
  |
  +--> session_store append turn
  v
Browser receives reply + audio data URL
  |
  +--> chat bubble
  +--> expression + gesture
  +--> AudioPlayer plays speech
  +--> AvatarScene lip-syncs from analyser
```

```mermaid
sequenceDiagram
  actor User
  participant UI as Browser app.js
  participant API as FastAPI route
  participant Service as AvatarConversationService
  participant Store as InMemorySessionStore
  participant OpenAI as OpenAI APIs
  participant Avatar as AvatarScene + AudioPlayer

  User->>UI: Type message and click Send
  UI->>API: POST /api/conversations/:id/messages\ninteraction_mode = chat
  API->>Service: send_message(message, voice, chat)
  Service->>Store: read last_response_id
  Service->>OpenAI: POST /v1/responses
  OpenAI-->>Service: structured avatar reply JSON
  Service->>OpenAI: POST /v1/audio/speech
  OpenAI-->>Service: audio bytes
  Service->>Store: append turn and response_id
  Service-->>API: ChatResponse
  API-->>UI: reply + audio data URL
  UI->>Avatar: set emotion, gesture, play audio
  Avatar-->>User: rendered face, motion, spoken reply
```

## Live Interview Turn

Live mode is pause-detected turn-taking. It is not WebRTC streaming. The browser records a turn, detects a pause, sends the audio for transcription, then sends the transcript as a live-interview message.

```text
User clicks Live
  |
  v
Browser starts mic capture
  |
  v
MicRecorder samples time-domain audio
  |
  +-- no speech yet for idleTimeoutMs
  |      -> reset recorder and keep listening
  |
  +-- speech level >= speechThreshold
         |
         v
      speechStarted = true
         |
         v
      user pauses for silenceMs
         |
         v
      stop recording with reason = silence
         |
         v
      transcribe audio
         |
         v
      send transcript with interaction_mode = live_interview
         |
         v
      Aria speaks reply
         |
         v
      audio ended
         |
         v
      if Live is still on, start listening again
```

```mermaid
sequenceDiagram
  actor User
  participant UI as Browser app.js
  participant Rec as MicRecorder
  participant Speech as /api/speech/transcriptions
  participant Msg as /api/conversations/:id/messages
  participant OpenAI as OpenAI APIs
  participant Player as AudioPlayer

  User->>UI: Click Live
  UI->>Rec: start(autoStopOnSilence = true)
  Rec-->>UI: status Listening
  User->>Rec: Speak answer
  Rec->>Rec: RMS >= speechThreshold
  User->>Rec: Pause
  Rec->>Rec: silence duration >= silenceMs
  Rec-->>UI: recording event with audio blob
  UI->>Speech: POST audio blob
  Speech->>OpenAI: audio transcription
  OpenAI-->>Speech: transcript
  Speech-->>UI: { text }
  UI->>Msg: POST transcript\ninteraction_mode = live_interview
  Msg->>OpenAI: Responses + speech
  OpenAI-->>Msg: reply JSON + audio bytes
  Msg-->>UI: ChatResponse
  UI->>Player: play reply audio
  Player-->>UI: ended
  UI->>Rec: restart if Live still enabled
```

## Live Mode State Machine

The visible top-bar status follows this lifecycle.

```text
Ready
  |
  | user clicks Live
  v
Listening
  |
  | speech then pause
  v
Pause detected
  |
  | transcription request
  v
Thinking
  |
  | model + TTS response ready
  v
Speaking
  |
  | audio ended and Live still on
  v
Listening

Any state
  |
  | user clicks Live off, New, or mic cancel
  v
Ready

Any request failure
  |
  v
Live reply failed / Transcription failed / Mic error
```

```mermaid
stateDiagram-v2
  [*] --> Ready
  Ready --> Listening: Live on
  Listening --> Listening: idle timeout and still live
  Listening --> PauseDetected: speech then silence
  PauseDetected --> Transcribing: submit audio
  Transcribing --> Thinking: transcript received
  Thinking --> Speaking: reply + TTS received
  Speaking --> Listening: audio ended and Live on

  Listening --> Ready: Live off
  PauseDetected --> Ready: Live off
  Transcribing --> Ready: Live off
  Thinking --> Ready: Live off
  Speaking --> Ready: Live off

  Listening --> MicError: permission denied
  Transcribing --> TranscriptionFailed: transcription error
  Thinking --> LiveReplyFailed: message or TTS error
  MicError --> Ready: user retries
  TranscriptionFailed --> Ready: user retries
  LiveReplyFailed --> Ready: user retries
```

## Data Contracts

The browser must always send `interaction_mode`. This keeps typed turns and pause-detected turns explicit.

```text
POST /api/conversations/{conversation_id}/messages

Request:
{
  "message": "I finished describing my last project.",
  "voice": "alloy",
  "interaction_mode": "live_interview"
}

Response:
{
  "conversation_id": "conv_...",
  "message_id": "msg_...",
  "response_id": "resp_...",
  "reply": {
    "text": "Thanks. What was the toughest part?",
    "emotion": "neutral",
    "gesture": "nod",
    "listen_hint": ""
  },
  "audio": {
    "mime_type": "audio/mpeg",
    "format": "mp3",
    "data_url": "data:audio/mpeg;base64,..."
  },
  "usage": {}
}
```

```mermaid
classDiagram
  class ChatRequest {
    string message
    string? voice
    InteractionMode interaction_mode
  }

  class InteractionMode {
    chat
    live_interview
  }

  class AvatarReply {
    string text
    Emotion emotion
    Gesture gesture
    string listen_hint
  }

  class AudioPayload {
    string mime_type
    string format
    string data_url
  }

  class ChatResponse {
    string conversation_id
    string message_id
    string? response_id
    AvatarReply reply
    AudioPayload audio
    dict? usage
  }

  ChatRequest --> InteractionMode
  ChatResponse --> AvatarReply
  ChatResponse --> AudioPayload
```

## OpenAI Boundary

The browser never sees `OPENAI_API_KEY`. The key is read by the backend process only.

```text
Browser memory
  contains:
    - conversation id
    - selected voice
    - typed text
    - recorded audio blob
    - returned audio data URL
  does not contain:
    - OPENAI_API_KEY

Backend process
  contains:
    - OPENAI_API_KEY from shell or .env
    - OpenAIGateway HTTP client
    - in-memory session store
```

```mermaid
flowchart LR
  subgraph browser[Browser]
    ui[UI state]
    mic[Recorded audio blob]
    rendered[Avatar render and playback]
  end

  subgraph backend[Backend process]
    settings[Settings\nOPENAI_API_KEY loaded here]
    gateway[OpenAIGateway]
    sessions[InMemorySessionStore]
  end

  subgraph openai[OpenAI]
    responses[Responses API]
    tts[Audio speech API]
    stt[Audio transcription API]
  end

  ui -->|message request| gateway
  mic -->|transcription request| gateway
  gateway --> responses
  gateway --> tts
  gateway --> stt
  settings --> gateway
  gateway --> sessions
  gateway -. never sends key to browser .-> ui
```

## Session Continuity

The local store is deliberately small. OpenAI continuity is carried by `previous_response_id`.

```text
ConversationState
|
+-- conversation_id
+-- created_at
+-- updated_at
+-- turns[]
+-- last_response_id  -----------------------------+
                                                     |
Next user turn                                      |
  |                                                  |
  v                                                  |
OpenAI Responses request includes previous_response_id
```

```mermaid
sequenceDiagram
  participant Store as InMemorySessionStore
  participant Service as AvatarConversationService
  participant OpenAI as OpenAI Responses

  Service->>Store: get conversation state
  Store-->>Service: last_response_id
  Service->>OpenAI: create response with previous_response_id
  OpenAI-->>Service: response id for new assistant turn
  Service->>Store: append turn and update last_response_id
```

## Failure Paths

Most failures are surfaced as short visible status messages rather than hidden console-only errors.

```text
Mic permission denied
  -> status: Mic error
  -> Live mode turns off

No speech during idleTimeoutMs
  -> recorder resets
  -> status remains Listening
  -> no transcription request is sent

Blank transcription
  -> no user turn added in live mode
  -> listener restarts

OpenAI transcription failure
  -> status: Transcription failed or Live reply failed
  -> system message added

Message/TTS failure
  -> status: Reply failed or Live reply failed
  -> system message added
```

```mermaid
flowchart TD
  start[Live listening]
  permission{Mic allowed?}
  speech{Speech detected?}
  pause{Pause detected?}
  transcribe{Transcript text?}
  reply{Reply and audio ok?}
  speak[Speak reply]
  restart[Restart listening]
  idle[Idle timeout\nreset recorder]
  micerr[Mic error]
  noText[No speech text\nrestart]
  fail[Visible error status\nsystem message]

  start --> permission
  permission -- no --> micerr
  permission -- yes --> speech
  speech -- no before timeout --> speech
  speech -- no after idleTimeoutMs --> idle --> restart
  speech -- yes --> pause
  pause -- no --> pause
  pause -- yes --> transcribe
  transcribe -- no --> noText --> restart
  transcribe -- yes --> reply
  reply -- no --> fail
  reply -- yes --> speak --> restart
```

## Timing Knobs

These values live in the browser because pause detection depends on the user's microphone and environment.

| Setting | Owner | Meaning |
| --- | --- | --- |
| `speechThreshold` | `frontend/src/app.js` -> `MicRecorder` | RMS level that counts as active speech. |
| `silenceMs` | `frontend/src/app.js` -> `MicRecorder` | Silence duration after speech before the turn is submitted. |
| `minSpeechMs` | `frontend/src/app.js` -> `MicRecorder` | Minimum speech duration before silence can stop recording. |
| `idleTimeoutMs` | `frontend/src/app.js` -> `MicRecorder` | No-speech timeout that resets live listening without sending audio. |
| `max_tts_chars` | `app/core/config.py` | Backend cap before sending text to TTS. |
| `session_ttl_seconds` | `app/core/config.py` | In-memory session lifetime. |

## Production Upgrade Map

The current design is intentionally local and debuggable. These are the main upgrade points.

```text
Current
  FastAPI static serving
  in-memory sessions
  local browser permissions
  REST turn-taking

Production options
  CDN or app host for frontend
  Redis/Postgres session store
  authentication and per-user conversation ownership
  CSRF/rate limits if cookies are used
  WebRTC/OpenAI realtime session if true streaming is required
```

```mermaid
flowchart LR
  current[Current local app]
  auth[Add auth]
  store[Replace memory store\nRedis or Postgres]
  deploy[Deploy backend and frontend]
  realtime[Optional true realtime\nWebRTC streaming]

  current --> auth
  current --> store
  current --> deploy
  current --> realtime
```

