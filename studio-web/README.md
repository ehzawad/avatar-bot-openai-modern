# Bengali Eval Studio (`studio-web`)

Voice-first React 19 + Vite + TypeScript app for building a Bengali conversational
eval dataset. It is a **separate** app from the existing avatar app in `../frontend`;
the avatar app at `/` keeps working unchanged.

Implements `docs/STUDIO_CONTRACT.md` section 5.

## Stack

- React 19 + Vite 7 + TypeScript (strict, `react-jsx`, bundler module resolution)
- TanStack Query v5 for server state (`src/api/queries.ts`)
- Zustand v5 + Zundo v2 for unsaved line-edit draft undo/redo (`src/features/editor/draftStore.ts`)
- Reducer-based `useRecorder` hook ported from `../frontend/src/audio/recorder.js`

## Develop

The backend (FastAPI) must be running on `http://127.0.0.1:8000`. The Vite dev
server proxies `/api/*` to it.

Start the backend from the **repo root** using its virtualenv (`uvicorn` lives in
`.venv/`, not system Python — otherwise you get `No module named uvicorn`):

```bash
# repo root, in another terminal:
source ../.venv/bin/activate && uvicorn app.main:app --reload --port 8000
# or without activating:  ../.venv/bin/uvicorn app.main:app --reload --port 8000
```

Then the Vite dev server (this folder):

```bash
npm install
npm run dev        # http://localhost:5173/studio/
```

## Build

```bash
npm run build      # tsc -b && vite build  ->  dist/
npm run preview    # serve the production build locally
```

The build emits `dist/` with `base: '/studio/'`. In production the FastAPI app
mounts `studio-web/dist` at `/studio` (see contract section 6), so all
root-relative `/api/...` calls hit the same origin.

## Layout

```
src/
  main.tsx                 QueryClientProvider (staleTime 5s, no refetch on focus, retry 1)
  App.tsx                  Shell: record bar, pending queue, cards, editor, timeline
  api/types.ts             TS types (contract section 4)
  api/client.ts            Typed fetch wrappers (contract section 3), FormData capture, 409 ConflictError
  api/queries.ts           TanStack hooks + query keys + invalidation rules
  features/recording/
    useRecorder.ts         getUserMedia + MediaRecorder(opus) + RMS meter, cleanup on unmount
    pendingStore.ts        Holds in-flight/failed captures + their blobs until server confirms
  features/editor/
    draftStore.ts          zustand + zundo temporal({limit:50}) over unsaved draft only
  components/              RecordBar, ModelTierSelect, FileCardFeed, FileCard,
                          LineEditor, RollbackTimeline, PendingQueue
  styles.css               Minimal dark theme; Bengali-capable font stack (.bn)
```

## Capture loop (contract section 5)

1. `client_segment_id` is generated at **record start**.
2. On Stop the blob becomes an optimistic pending row (`pendingStore`).
3. `useCapture` POSTs multipart to `/api/datasets/{id}/capture` (idempotent).
4. The audio blob is **never discarded until the server confirms the append**.
5. On success: drop the pending row, highlight the new row, clear zundo history,
   and on `rolled: true` switch the active page and toast "Page NNN created".
6. On error: the pending row stays with retry-same / retry-Best / edit / discard.
7. Download warns when unreviewed lines exist (accepted-only vs all).
