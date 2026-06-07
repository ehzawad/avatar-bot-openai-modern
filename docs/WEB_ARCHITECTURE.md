# Unified Frontend Architecture (`web/`)

This document describes the architecture of the **single** frontend app, `web/` — a Vite + React
+ TypeScript SPA that serves both the avatar (at `/`) and the Bengali Conversational Eval Studio
(at `/studio`). It is the design companion to the run instructions in the
[README](../README.md).

The authoritative frozen spec is [WEB_CONTRACT.md](WEB_CONTRACT.md); the studio API/schema spec is
[STUDIO_CONTRACT.md](STUDIO_CONTRACT.md). This document does **not** add endpoints or fields — it
explains how the implemented frontend is organized and why. The legacy `frontend/` (vanilla JS
avatar) and `studio-web/` (standalone studio) apps are retired and replaced by `web/`.

## Why one app

The avatar and the studio used to be two separate frontends mounted at two paths. They are now one
Vite app with one build, one router, and one shared library layer. This removes duplicated HTTP
clients, recorder logic, and TypeScript types, and lets FastAPI serve a single SPA. The two
surfaces are kept apart by **code splitting and CSS namespacing**, not by being separate apps.

The hard boundary that makes a single app safe: **Three.js / `@pixiv/three-vrm` are imported only
under `web/src/features/avatar/**`.** They must never be reachable (even transitively) from
`lib/**`, `router.tsx`, `main.tsx`, or `features/studio/**`. Because the routes are lazy, the
`/studio` chunk never pulls Three.

## Layout

```
web/
  package.json            # one set of deps for both surfaces (see below)
  tsconfig.json, tsconfig.node.json
  vite.config.ts          # base:'/', plugins:[react()], server.proxy '/api'->http://127.0.0.1:8000, build.outDir:'dist'
  index.html              # <div id="root">
  src/
    main.tsx              # StrictMode + QueryClientProvider + RouterProvider
    router.tsx            # createBrowserRouter, NO basename, lazy routes
    styles/base.css       # ONLY neutral resets + shared tokens (CSS vars); no component globals
    lib/                  # shared boundary — NO Three imports
      api/http.ts         # fetch wrapper: JSON + FormData, typed errors (incl. 409 revision_conflict)
      api/types.ts        # all shared TS types (avatar/conversation + studio)
      api/avatarClient.ts # health(), config(), createConversation(), sendMessage(), transcribe()
      api/studioClient.ts # datasets CRUD / capture / lines / revisions / rollback / download (incl. csv)
      api/avatarMutations.ts  # TanStack mutations for the avatar turn pipeline
      api/studioQueries.ts    # TanStack query/mutation hooks for datasets
      api/queryClient.ts  # QueryClient (staleTime 5000, refetchOnWindowFocus false, retry 1)
      audio/useRecorder.ts    # ONE shared recorder hook (manual + live/silence)
      hooks/useLatest.ts      # ref-of-latest-value helper for race guards
    features/
      avatar/             # lazy chunk — the ONLY place Three.js lives
        route.tsx
        AvatarApp.tsx
        avatar.css            # all selectors namespaced under .avatar-app
        audio/AudioPlayer.ts  # imperative TTS playback + mouth-level analyser
        scene/AvatarRuntime.ts    # imperative Three.js engine
        scene/useAvatarScene.ts   # thin React bridge to the engine
        hooks/useAvatarChat.ts    # reducer state machine + race guards
        components/ChatView, Composer, RuntimePanel, StatusPill, ModelUpload
      studio/             # lazy chunk — no Three
        route.tsx
        StudioApp.tsx
        studio.css            # all selectors namespaced under .studio-app
        components/RecordBar (+ tag box), ModelTierSelect, FileCardFeed,
                   FileCard (+ .csv), LineEditor (+ per-line tag), RollbackTimeline, PendingQueue
        editor/draftStore.ts      # zustand + zundo, unsaved line-edit drafts only
        recording/pendingStore.ts # in-flight / failed captures
```

Dependencies are a single `web/package.json`: React 19, `react-dom`, `react-router@7`,
`@tanstack/react-query@5`, `zustand@5`, `zundo@2`, `three`, `@pixiv/three-vrm` (avatar only);
dev: `vite@7`, `@vitejs/plugin-react`, `typescript@5`, the `@types/*`. Scripts: `dev` (Vite),
`build` = `tsc -b && vite build`, `preview`.

## Router and lazy routes

`router.tsx` uses React Router 7 in data mode with **no basename** (the app is served from `/`):

```ts
createBrowserRouter([
  { path: '/', children: [
    { index: true,        lazy: () => import('./features/avatar/route') }, // avatar
    { path: 'studio/*',   lazy: () => import('./features/studio/route') }, // studio
  ]},
])
```

Each `route.tsx` is the lazily-imported entry for its feature. Lazy imports are what enforce the
Three boundary at the bundle level: visiting `/studio` never evaluates the avatar module, so its
chunk contains no Three.js. Each page's header links to the other surface (`/` ⇄ `/studio`).

## Shared `lib/` boundary

Everything that both surfaces need lives in `lib/` and is deliberately Three-free:

- **`api/http.ts`** — one fetch wrapper for JSON and `FormData`, with typed errors including the
  studio's `409 revision_conflict`.
- **`api/types.ts`** — all shared TypeScript types: the avatar/conversation types (`Emotion`,
  `Gesture`, `InteractionMode`, `AvatarReply`, `AudioPayload`, `ChatResponse`, `PublicConfig`,
  `HealthResponse`) and the studio types (`DatasetCard`, `Line` — including `tag: string | null` —
  `DatasetDetail`, `Revision`, `AppendResult`, etc.). Types mirror the backend responses exactly.
- **`api/avatarClient.ts` / `api/studioClient.ts`** — thin clients over `http.ts`.
- **`api/avatarMutations.ts` / `api/studioQueries.ts`** — TanStack Query hooks. Server state
  (health, config, datasets, a dataset's detail and revisions) is queries; everything that changes
  the server is a mutation, and successful mutations invalidate the relevant query keys.
- **`api/queryClient.ts`** — the shared `QueryClient`.
- **`audio/useRecorder.ts`** and **`hooks/useLatest.ts`** — the shared recorder and the
  latest-value ref helper used by the avatar's race guards.

Avatar endpoints used by `avatarClient` (unchanged backend): `GET /api/health`, `GET /api/config`,
`POST /api/conversations`, `POST /api/conversations/{id}/messages`,
`POST /api/speech/transcriptions`. Studio endpoints are those in STUDIO_CONTRACT §3 plus the CSV
`download?format=csv` variant.

## Avatar scene: `AvatarRuntime` + `useAvatarScene`

The Three.js engine is **imperative** and kept out of React's render cycle.

- **`scene/AvatarRuntime.ts`** is a plain TypeScript engine (ported from the legacy
  `avatarScene` / `modelLoader` / `expressionController`). It owns the renderer, camera (35° FOV at
  `(0, 0.85, 1.85)`), OrbitControls (damping 0.06, min 0.65, max 5), lights, blink loop
  (~2–6 s, 0.16 s), idle motion, emotion presets (4.8 s auto-reset to neutral), gestures
  (`nod` / `shake` / `lean_in` / `wave`), the procedural fallback avatar, and the VRM/GLB loader
  (morph-target auto-map for `viseme_aa` / `jawOpen` → mouth and `blink` → eyes). Each frame it
  drives the mouth from `getMouthLevel()`.

- **`scene/useAvatarScene.ts`** is a thin bridge hook:

  ```ts
  useAvatarScene(containerRef, {
    getMouthLevel, // () => number, read inside RAF — never React state per frame
    emotion,       // Emotion | null (durable)
    gestureEvent,  // { id; type:Gesture } | null (event; effect keyed on id)
    modelUrl,      // string | null (durable; null => fallback)
  }): { loadUploadedFile(file): Promise<void>; resetToFallback(): void }
  ```

Engine discipline:

- The init effect depends only on the container and guards `if (runtimeRef.current) return`, so
  StrictMode's double-invoke is idempotent; teardown is symmetrical.
- **Mandatory cleanup on unmount:** set a `disposed` flag, cancel RAF, clear all
  blink/emotion/gesture timers, bump a `loadSeq` so a late model load is ignored and disposed,
  disconnect the `ResizeObserver`, remove the named
  `pointermove` / `webglcontextlost` / `webglcontextrestored` / `visibilitychange` listeners,
  `controls.dispose()`, remove and dispose the current VRM scene and the fallback (geometries,
  materials, textures, skeletons), `renderer.dispose()` + `renderer.forceContextLoss()`, remove
  the canvas, and null heavy refs. Audio is not touched here.
- Resize is driven by a `ResizeObserver` on the container (not `window.innerWidth`), guards
  zero-size, uses `renderer.setSize(w, h, false)`, keeps DPR at `min(devicePixelRatio, 2)`, and
  the canvas is CSS `width:100%; height:100%; display:block`.
- WebGL context loss is handled: `webglcontextlost` → `preventDefault` + pause RAF;
  `webglcontextrestored` → resize + restart.
- Uploaded models are object URLs revoked in `finally`; only `.glb` / `.vrm` / `.gltf` (single
  file) are accepted.

## Avatar chat: `useAvatarChat` state machine

`hooks/useAvatarChat.ts` is a reducer-driven state machine with **no Three imports**. Phases:
`creating | idle | listening | transcribing | thinking | speaking | error`. `liveMode` is a loop
preference, not a phase. The hook emits `onAvatarCue({ emotion, gesture })` (the page wires it to
the scene) and exposes `getMouthLevel` from the AudioPlayer.

```ts
useAvatarChat({ audioPlayer, recorder, defaultVoice, onAvatarCue }): {
  phase, status, messages, conversationId, voice, liveMode, micLevel,
  canSend, canRecord, canStop,
  setVoice, sendTyped, startManualRecording, stopRecording, toggleLiveMode, newChat,
}
```

- **Transport** is TanStack mutations (`useCreateConversation` / `useTranscribe` /
  `useSendMessage`, via `mutateAsync`); `health` / `config` are queries; transcript, phase, and
  loop state are local reducer state.
- **Race guards** are synchronous and applied before re-render: a `turnSeqRef`, an `activeTurnRef`
  (`{ id, source, abort: AbortController }`), a `liveEpochRef`, and `phaseRef` / `liveModeRef` kept
  current via `useLatest`. `beginTurn()` returns null unless the latest phase is `idle`, and every
  async step rechecks `isCurrentTurn(turn)` so a stale turn cannot mutate the UI.
- **Turn pipeline** (typed / manual / live): create the conversation if needed → (for mic input)
  transcribe → add the user message → `sendMessage` → `onAvatarCue(emotion, gesture)` → play the
  TTS for that turn → return to `idle`. In live mode, exactly one follow-up listen is scheduled
  (single timeout) only when playback **ended** naturally — a **stopped** playback does not loop.
  New chat cancels the recorder, aborts in-flight fetches, stops audio, clears the live timeout,
  bumps the epochs, resets the transcript, starts a fresh conversation, and turns live off.
- **AudioPlayer** is created once (`useMemo`) and disposed on unmount; `unlock()` runs on the
  first user gesture (send / mic / live) for the autoplay policy; `playDataUrl(url, token)` returns
  `'ended' | 'stopped' | 'superseded'`; `getMouthLevel()` is handed to `useAvatarScene`.
- UI affordances derive from phase (`isBusy = phase !== 'idle'`): typed send is disabled while
  listening / transcribing / thinking / speaking, and New chat is enabled on `idle` / `error`.

## Shared recorder: `lib/audio/useRecorder.ts`

One recorder hook serves both surfaces — the studio's manual capture and the avatar's manual and
live (silence-detected) loops — so neither has its own copy.

```ts
type RecorderMode = 'manual' | 'live';
type StopReason = 'manual' | 'silence' | 'idle' | 'cancel';
```

- It uses `MediaRecorder` with `audio/webm;codecs=opus` (falling back to `audio/webm`) and an
  `AnalyserNode` RMS meter for live silence detection (warmup, minimum-speech, silence window,
  idle timeout) ported from the legacy recorder.
- It exposes recorder state (`idle | requesting_mic | recording | stopping`), a `level` plus a
  `levelRef` (so meters can animate from RAF without re-rendering), `speaking` / `speechStarted`,
  and an `error`, plus `start(opts) => { finished: Promise<RecorderResult> }`, `stop(reason?)`,
  `cancel()`, and `reset()`.
- The avatar consumes the **session model** — it `start()`s and awaits the `finished` result to
  decide whether to transcribe — rather than reacting to a "blob appeared in state" effect. The
  studio keeps its manual ergonomics. The live preset is `{ mode:'live',
  autoStopOnSilence:true, silenceMs:950, minSpeechMs:360, speechThreshold:0.035, warmupMs:250,
  idleTimeoutMs:15000 }`; `manual` is the default.
- Cleanup on unmount stops tracks, closes the `AudioContext`, and cancels RAF; `stop()` is
  idempotent and `cancel()` drops the blob without dispatching.

## Single-SPA FastAPI serve

There is one build (`web/dist`) and one mount. FastAPI keeps the API router first, then serves the
SPA for everything else:

```python
WEB_DIST = ROOT / "web" / "dist"
if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa_fallback(path: str):
        candidate = (WEB_DIST / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(WEB_DIST):
            return FileResponse(candidate)
        if path.startswith("api/") or "." in Path(path).name:
            raise HTTPException(status_code=404)
        return FileResponse(WEB_DIST / "index.html")
```

- API routes are matched first; hashed assets are served from `/assets/*`; any other route falls
  back to `index.html`, so a hard reload of `/studio` returns the SPA rather than a 404.
- A missing asset (a path with a file extension, or anything under `api/`) returns a real 404
  instead of `index.html`, so broken asset URLs fail loudly.
- The serve block is guarded by `WEB_DIST.exists()`, so the backend still imports and runs before
  the frontend is built (in dev you use the Vite server + proxy instead).
- `index.html` is served `no-cache`; hashed `/assets/*` can be cached long/immutable.
- `data/` (SQLite + audio) is **never** web-served — only `web/dist` is.

## CSS namespacing

`styles/base.css` carries only neutral resets and shared design tokens (CSS variables) — no
component-level globals. Each feature scopes all of its selectors: avatar styles under
`.avatar-app` (`features/avatar/avatar.css`) and studio styles under `.studio-app`
(`features/studio/studio.css`). Because the two surfaces share one document and one stylesheet
bundle, this prevents selectors like `.btn` or bare element rules from leaking across routes while
preserving the shared glassy-dark aesthetic (glow accents, status pill).
