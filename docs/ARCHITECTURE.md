# Architecture

For visual system maps, request flow diagrams, state machines, and security boundaries, see [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md).

## Backend modules

`app/main.py` wires FastAPI, static frontend serving, CORS, and application state.

`app/api/routes/*` contains HTTP concerns only: validation, route shape, and HTTP errors.

`app/domain/*` contains transport-neutral schemas and prompts.

`app/services/openai_gateway.py` is the only module that knows OpenAI endpoint details.

`app/services/orchestrator.py` composes LLM response generation, speech generation, and session state.

`app/services/session_store.py` stores conversation state and the latest OpenAI `response_id`.

## Frontend modules

`frontend/src/api/client.js` owns backend HTTP calls.

`frontend/src/avatar/*` owns Three.js, VRM/GLB loading, expressions, gestures, idle animation, blinking, and lip-sync.

`frontend/src/audio/*` owns microphone recording and audio playback/analyser logic.

`frontend/src/ui/*` owns DOM manipulation.

`frontend/src/app.js` is composition glue only.

## Key design decisions

The browser does not receive the OpenAI key. All OpenAI traffic goes through the backend.

The assistant reply is structured JSON rather than text with a magic emotion tag. This avoids regex fragility and keeps the backend/frontend contract explicit.

The backend stores only lightweight local session metadata. It relies on `previous_response_id` to let OpenAI continue context without resending the entire transcript every turn.

Speech-to-text is optional but implemented with OpenAI transcription so the full voice loop can be OpenAI-based.
