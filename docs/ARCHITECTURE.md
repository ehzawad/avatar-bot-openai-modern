# Architecture

> **Frontend note (updated):** the browser layer is now a single unified Vite + React + TypeScript
> app in `web/` (landing at `/`, avatar at `/avatar`, Bengali eval studio at `/studio`), served by FastAPI from
> `web/dist`. The legacy `frontend/` and `studio-web/` dirs were retired; see
> [WEB_ARCHITECTURE.md](WEB_ARCHITECTURE.md) for the fuller frontend map.

For visual system maps, request flow diagrams, state machines, and security boundaries, see [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md).

## Backend modules

`app/main.py` wires FastAPI, static frontend serving, CORS, and application state.

`app/api/routes/*` contains HTTP concerns only: validation, route shape, and HTTP errors.

`app/domain/*` contains transport-neutral schemas and prompts.

`app/services/openai_gateway.py` is the only module that knows OpenAI endpoint details.

`app/services/orchestrator.py` composes LLM response generation, speech generation, and session state.

`app/services/session_store.py` stores conversation state and the latest OpenAI `response_id`.

## Frontend modules

`web/src/router.tsx` owns the client route table: eager Home at `/`, lazy Avatar at `/avatar`,
and lazy Studio at `/studio/*`.

`web/src/features/home/*` owns the lightweight landing page and imports no avatar feature code.

`web/src/features/avatar/*` owns Three.js, VRM/GLB loading, expressions, gestures, idle animation,
blinking, lip-sync, the avatar chat state machine, and avatar-specific UI.

`web/src/features/studio/*` owns the Bengali Eval Studio shell, recording/editing components,
pending captures, local draft undo, and studio-specific UI.

`web/src/lib/*` owns shared API clients, TanStack Query hooks, shared recorder logic, and small
cross-feature helpers. It must stay free of Three.js imports.

## Key design decisions

The browser does not receive the OpenAI key. All OpenAI traffic goes through the backend.

The assistant reply is structured JSON rather than text with a magic emotion tag. This avoids regex fragility and keeps the backend/frontend contract explicit.

The backend stores only lightweight local session metadata. It relies on `previous_response_id` to let OpenAI continue context without resending the entire transcript every turn.

Speech-to-text is optional but implemented with OpenAI transcription so the full voice loop can be OpenAI-based.
