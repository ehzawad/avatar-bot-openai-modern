# Unified `web/` Frontend — FROZEN CONTRACT (v1)

Single source of truth for: migrating the avatar app to React, **unifying** it with the studio
into one Vite+React+TS app `web/`, switching FastAPI to a single SPA serve, **jettisoning** the
legacy `frontend/` + `studio-web/`, and the two studio additions (**per-line tag** + **CSV
export**). Reconciled from a 4-role codex council (threejs-react-hook, monorepo-unify-vite,
realtime-chat-audio-state, migration-safety) + the existing `docs/STUDIO_CONTRACT.md` (the studio
API is unchanged except the deltas in §6).

Build quality bar: **no shortcuts.** Full avatar feature parity, robust state machine, first-class
cleanup, polished/consistent UI. Where a detail is unspecified, choose the robust option.

---

## 0. Guardrails
- Backend changes are limited to: (a) the static-serve switch, (b) the `tag` column, (c) CSV
  export. **Do NOT** churn `OpenAIGateway`, Pydantic conversation/health schemas,
  `/api/conversations`, `/api/speech`, the existing dataset routes, CORS, or storage logic.
- Three.js / `@pixiv/three-vrm` imports live **only** under `web/src/features/avatar/**`. They
  must never be imported (even transitively) by `lib/**`, `router.tsx`, `main.tsx`, or
  `features/studio/**` — verify `/studio`'s chunk does not pull Three.
- `data/` (sqlite + audio) stays non-web-served. Serve only `web/dist`.
- Preserve the existing visual aesthetic (glassy dark panels, glow accents, status pill) from
  `frontend/assets/css/styles.css` and `studio-web/src/styles.css`; unify into a consistent look.

---

## 1. Target layout (`web/`)
```
web/
  package.json            # see §2
  tsconfig.json, tsconfig.node.json
  vite.config.ts          # base:'/', plugins:[react()], server.proxy '/api'->http://127.0.0.1:8000, build.outDir:'dist'
  index.html              # <div id="root">, title "Aria — OpenAI Avatar & Bengali Eval Studio"
  src/
    main.tsx              # StrictMode + QueryClientProvider + RouterProvider
    router.tsx            # createBrowserRouter, NO basename, lazy routes (see §3)
    styles/base.css       # ONLY neutral resets + shared tokens (CSS vars). No component globals.
    lib/
      api/http.ts         # fetch wrapper: JSON + FormData, typed errors (incl 409 revision_conflict)
      api/types.ts        # all shared TS types (studio + avatar/conversation). See §4 + STUDIO_CONTRACT §4
      api/avatarClient.ts # health(), config(), createConversation(), sendMessage(), transcribe()
      api/studioClient.ts # datasets CRUD/capture/lines/revisions/rollback/download (incl csv)
      api/avatarMutations.ts  # useCreateConversation/useTranscribe/useSendMessage (NO three imports)
      api/studioQueries.ts    # TanStack hooks for datasets (port from studio-web/src/api/queries.ts)
      api/queryClient.ts  # QueryClient: staleTime 5000, refetchOnWindowFocus false, retry 1
      audio/useRecorder.ts    # ONE shared recorder hook, manual + live/silence (see §5)
      hooks/useLatest.ts      # ref-of-latest-value helper
    features/
      avatar/
        route.tsx         # default export route element; lazy-loaded
        AvatarApp.tsx     # page shell (full-window canvas + glassy panels)
        avatar.css        # ALL selectors namespaced under .avatar-app
        audio/AudioPlayer.ts        # imperative; unlock()/playDataUrl(token)/stop()/getMouthLevel()/dispose()
        scene/AvatarRuntime.ts      # imperative Three.js engine (port avatarScene+modelLoader+expressionController)
        scene/useAvatarScene.ts     # thin bridge hook (see §7)
        hooks/useAvatarChat.ts      # reducer state machine + race guards (see §8)
        components/ChatView.tsx, Composer.tsx, RuntimePanel.tsx, StatusPill.tsx, ModelUpload.tsx
      studio/
        route.tsx         # default export route element; lazy-loaded
        StudioApp.tsx     # port from studio-web App.tsx
        studio.css        # ALL selectors namespaced under .studio-app
        components/*       # port RecordBar (+ Tag box), ModelTierSelect, FileCardFeed, FileCard (+ .csv),
                          #   LineEditor (+ per-line tag), RollbackTimeline, PendingQueue
        editor/draftStore.ts        # port (zundo)
        recording/pendingStore.ts   # port
```

## 2. Dependencies (single `web/package.json`)
deps: `react@^19`, `react-dom@^19`, `react-router@^7`, `@tanstack/react-query@^5`, `zustand@^5`,
`zundo@^2`, `three@^0.16x` (latest), `@pixiv/three-vrm@^3` (latest compatible).
devDeps: `vite@^7`, `@vitejs/plugin-react`, `typescript@^5`, `@types/react`, `@types/react-dom`,
`@types/three`. Scripts: `dev`, `build` = `tsc -b && vite build`, `preview`.
`tsconfig.node.json` must NOT set both `composite:true` and `noEmit:true` (use
`emitDeclarationOnly:true`) — known TS6310 trap.

## 3. Router (React Router 7, data mode, no basename)
```ts
createBrowserRouter([
  { path: '/', children: [
    { index: true, lazy: () => import('./features/avatar/route') },   // avatar
    { path: 'studio/*', lazy: () => import('./features/studio/route') }, // studio
  ]},
])
```
Each `route.tsx` exports `{ Component }` (or `default`) per the router API used. Lazy so Three.js
only loads on `/`. Header on each page links to the other (`/` ⇄ `/studio`).

## 4. Avatar/conversation TS types (`lib/api/types.ts`)
```ts
export type Emotion = 'neutral'|'joy'|'sorrow'|'angry'|'fun'|'surprised';
export type Gesture = 'idle'|'nod'|'shake'|'lean_in'|'wave';
export type InteractionMode = 'chat'|'live_interview';
export interface AvatarReply { text:string; emotion:Emotion; gesture:Gesture; listen_hint:string }
export interface AudioPayload { mime_type:string; format:string; data_url:string }
export interface ChatResponse { conversation_id:string; message_id:string; response_id:string|null;
  reply:AvatarReply; audio:AudioPayload; usage?:Record<string,unknown>|null }
export interface PublicConfig { response_model:string; tts_model:string; transcribe_model:string;
  default_voice:string; voices:string[]; emotions:Emotion[]; gestures:Gesture[];
  // studio fields (already added):
  transcribe_tiers:{id:string;label:string;model:string}[]; stt_prompts:{id:string;label:string}[];
  languages:string[]; dataset_page_size_default:number }
export interface HealthResponse { status:string; openai_configured:boolean;
  response_model:string; tts_model:string; transcribe_model:string }
```
Studio types: port from `studio-web/src/api/types.ts` and **add `tag: string | null`** to `Line`
(see §6).

avatarClient endpoints (unchanged backend): `GET /api/health`, `GET /api/config`,
`POST /api/conversations` → `{conversation_id,created_at}`,
`POST /api/conversations/{id}/messages` body `{message,voice,interaction_mode}` → `ChatResponse`,
`POST /api/speech/transcriptions` (multipart `audio`) → `{text}`.

## 5. Shared recorder (`lib/audio/useRecorder.ts`) — port + extend
Port `frontend/src/audio/recorder.js` semantics into a React hook (the studio's current
useRecorder lacks live/silence — extend, don't regress studio's manual mode).
```ts
type RecorderMode = 'manual'|'live';
type StopReason = 'manual'|'silence'|'idle'|'cancel';
interface RecorderStartOptions { mode?:RecorderMode; autoStopOnSilence?:boolean;
  speechThreshold?:number; silenceMs?:number; minSpeechMs?:number; warmupMs?:number;
  idleTimeoutMs?:number|null }
interface RecorderResult { blob:Blob; durationMs:number; mode:RecorderMode; reason:StopReason;
  speechStarted:boolean }
```
Returns: `{ state:'idle'|'requesting_mic'|'recording'|'stopping', level:number, speaking:boolean,
speechStarted:boolean, error:Error|null, levelRef (for RAF/meters without re-render),
start(opts)=>Promise<{finished:Promise<RecorderResult>}> , stop(reason?), cancel(), reset() }`.
- MediaRecorder `audio/webm;codecs=opus` (fallback `audio/webm`); silence detection via
  AnalyserNode RMS exactly like the legacy (warmup, minSpeech, silence, idleTimeout).
- Cleanup on unmount: stop tracks, close AudioContext, cancel RAF. `cancel()` drops the blob
  (no dispatch). Idempotent stop. Defaults: manual mode. Live preset: `{mode:'live',
  autoStopOnSilence:true, silenceMs:950, minSpeechMs:360, speechThreshold:0.035, warmupMs:250,
  idleTimeoutMs:15000}`.
- Avatar consumes the `start()→{finished}` session model (await the result); studio keeps its
  current ergonomics. Do NOT drive transcription off a "blob appeared in state" effect.

## 6. Studio deltas — TAG + CSV (backend + frontend)
**Tag (per-line, optional, nullable):**
- DB: add `tag TEXT` (nullable, default NULL) to `lines` AND `revision_lines`. Migrate existing DB
  with `ALTER TABLE ... ADD COLUMN tag TEXT` guarded by a column-exists check (idempotent startup
  migration). Snapshot/rollback must carry `tag`.
- API: `tag` accepted (optional) on `POST .../capture`, `POST .../lines`, and
  `PATCH .../lines/{id}`. Empty string or whitespace → stored as `NULL`. `Line` response gains
  `tag: string|null`.
- Frontend: ONE tag text box in `RecordBar` (sticky value, applied as `tag` to each capture; null
  if empty) AND an editable tag field per row in `LineEditor`.

**CSV export:**
- `GET /api/datasets/{dataset_id}/download?format=csv&scope=all` → `text/csv; charset=utf-8`
  attachment, sanitized `Content-Disposition` filename `<name>.csv`.
- Columns: header row `text,tagname` then one row per non-deleted line in `line_index` order.
- **RFC-4180 quoting: every field wrapped in double quotes; embedded `"` doubled (`""`).** Null
  tag → empty quoted field `""`. UTF-8 (Bengali) preserved; prepend a UTF-8 BOM is OPTIONAL (skip).
  Example:
  ```
  text,tagname
  "আজ তুমি কেমন আছো?","greeting"
  "আমি ভালো আছি, ""সত্যিই""।",""
  ```
- `scope`: `all` (default, all non-deleted) or `accepted` (review_status='accepted'), mirroring the
  txt/jsonl scope handling.
- Frontend: a `.csv` download control on `FileCard` next to `.txt`/`.jsonl`.
- Extend `scripts/smoke_datasets.py` to assert: a line with a tag and a comma+quote in its text
  round-trips through CSV with correct quoting; a null-tag line emits `""`.

## 7. `useAvatarScene` (thin bridge) + `AvatarRuntime` (imperative engine)
Port `frontend/src/avatar/{avatarScene,modelLoader,expressionController}.js` **verbatim in
behavior** into TS inside `AvatarRuntime` (keep ALL constants: camera 35°FOV pos (0,0.85,1.85),
OrbitControls damping 0.06 / min 0.65 / max 5, lights 1.1/1.4/1.2, blink ~2–6s & 0.16s, idle
motion math, emotion presets w/ 4.8s auto-reset to neutral, gestures nod/shake/lean_in/wave,
procedural fallback avatar, VRM/GLB loader with morph-target auto-map for `viseme_aa`/`jawOpen`→
mouth & `blink`→eyes, mouth = `expression.setMouth(getMouthLevel())` per frame).
```ts
export function useAvatarScene(containerRef, {
  getMouthLevel, // () => number  (read inside RAF; never React state per frame)
  emotion,       // Emotion | null  (durable)
  gestureEvent,  // { id:string; type:Gesture } | null  (event; key effect on id)
  modelUrl,      // string | null   (durable; null => fallback)
}): { loadUploadedFile(file:File):Promise<void>; resetToFallback():void }
```
Rules (council):
- Init effect depends ONLY on the container; guard `if (runtimeRef.current) return` (StrictMode
  idempotent). Symmetrical teardown.
- Cleanup checklist (MANDATORY): `disposed=true`; cancel RAF; clear all gesture/emotion/blink
  timers; increment `loadSeq` so late model loads are ignored+disposed; disconnect ResizeObserver;
  remove named `pointermove`/`webglcontextlost`/`webglcontextrestored`/`visibilitychange`
  listeners; `controls.dispose()`; remove+dispose current vrm scene + fallback (geometries,
  materials, textures, skeletons); `renderer.dispose()` + `renderer.forceContextLoss()`; remove
  canvas; null heavy refs. Do NOT touch AudioPlayer here.
- Resize via `ResizeObserver` on the container (NOT window.innerWidth); guard zero-size;
  `renderer.setSize(w,h,false)`; canvas CSS `width:100%;height:100%;display:block`; keep DPR
  `min(devicePixelRatio,2)` in the resize path. Container CSS must give nonzero size (e.g. fixed
  full-window behind panels).
- `webglcontextlost` → preventDefault + pause RAF; `webglcontextrestored` → resize + restart.
- Vite imports: `three`, `three/examples/jsm/controls/OrbitControls.js`,
  `three/examples/jsm/loaders/GLTFLoader.js`, `@pixiv/three-vrm` `VRMLoaderPlugin`. No importmap.
- Uploaded file: object URL revoked in `finally`; only `.glb/.vrm/.gltf` (single-file).

## 8. `useAvatarChat` state machine (no Three imports)
Phases: `creating|idle|listening|transcribing|thinking|speaking|error`. `liveMode` is a loop
preference, not a phase. Emits `onAvatarCue({emotion,gesture})` (the page wires it to the scene)
and exposes `getMouthLevel` from the AudioPlayer.
```ts
useAvatarChat({ audioPlayer, recorder, defaultVoice, onAvatarCue }): {
  phase, status, messages, conversationId, voice, liveMode, micLevel,
  canSend, canRecord, canStop,
  setVoice, sendTyped, startManualRecording, stopRecording, toggleLiveMode, newChat,
}
```
- Transport via TanStack mutations (`useCreateConversation/useTranscribe/useSendMessage`,
  `mutateAsync`). `health`/`config` are queries. Transcript/phase/loop are LOCAL reducer state.
- Race guards (synchronous, before re-render): `turnSeqRef`, `activeTurnRef` ({id, source, abort:
  AbortController}), `liveEpochRef`, `phaseRef`/`liveModeRef` via `useLatest`. `beginTurn()`
  returns null unless `phaseRef.current==='idle'`; every async step checks `isCurrentTurn(turn)`.
- Turn pipeline (typed/manual/live): create conv if needed → (mic: transcribe) → add user msg →
  sendMessage → onAvatarCue(emotion,gesture) → play TTS (token) → idle; if liveMode and audio
  ended naturally (not stopped) → schedule one listen (single timeout). Distinguish `ended` vs
  `stopped`. New chat: cancel recorder, abort fetches, stop audio, clear live timeout, bump
  epochs, reset transcript, new conversation, liveMode off.
- AudioPlayer: `useMemo(()=>new AudioPlayer(),[])` + dispose on unmount; `unlock()` from first user
  gesture (send/mic/live click) for autoplay policy; `playDataUrl(url, token)` returns
  `'ended'|'stopped'|'superseded'`; `getMouthLevel()` passed to `useAvatarScene`.
- UI derives from phase: `isBusy = phase!=='idle'`; disable typed send during listening/
  transcribing/thinking/speaking; New chat enabled on idle/error.

## 9. Avatar page UI (`AvatarApp.tsx`) — parity + polish
Reproduce the legacy UX (and improve): full-window `<div class="canvas-root">` behind glassy
panels. Topbar: title "Aria" + StatusPill (tones map to phase: ready/busy/speaking/error).
Conversation panel: ChatView (roles → "You"/"Aria"/"System"), New button. Runtime panel:
model, tts (from config), Voice `<select>` (from config.voices, default config.default_voice),
ModelUpload (`<input type=file accept=".vrm,.glb,.gltf">` → `loadUploadedFile`). Composer: mic
(record/stop, recording state from phase), Live toggle (aria-pressed), text input (Enter to send,
Shift+Enter newline), Send. Boot: fetch health+config; if `!openai_configured` show a system
message + error status. Keep keyboard a11y; show mic-permission errors as a dedicated state, not a
silent toast.

## 10. FastAPI serve switch (`app/main.py`) — replace dual mounts
Keep `app.include_router(api_router)` FIRST. Then:
```py
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
- Remove the `/studio` + `/` StaticFiles mounts. Add PATCH already present in CORS. `index.html`
  → `Cache-Control: no-cache`; hashed `/assets/*` → long immutable cache (best-effort).
- Until `web/dist` exists, the app still imports/runs (the block is guarded). After verification,
  **delete `frontend/` and `studio-web/`** (git rm) and remove their now-dead references; update
  `.gitignore` (`web/node_modules/`, `web/dist/`; drop the studio-web ignores).

## 11. Verification gates
- Frontend: `cd web && npm install && npm run build` → type-clean, emits `dist/`. Inspect the
  build output: the `/studio` (studio) chunk must NOT include three/@pixiv/three-vrm; the avatar
  chunk is separate (lazy). Self-fix until clean.
- Backend: `python -c "import app.main"` clean; `python scripts/smoke_datasets.py` passes incl. the
  new tag + CSV assertions.
- Live: start uvicorn (web/dist built), assert: `GET /` returns the SPA, `GET /studio` hard-reload
  returns the SPA (not 404), `GET /api/health` JSON works, a missing `/assets/x.js` returns 404
  (not index.html), CSV download has correct quoting, tag round-trips.
- Headless render: `/` shows a non-blank canvas + WebGL context + 0 console errors (fallback
  avatar); `/studio` lists dataset cards + 0 console errors. (Visual fidelity = manual; note it.)

## 12. Integration review (final)
Check: no Three import reachable from lib/router/main/studio; CSS namespacing (no `.btn`/`body`
leakage across routes); SPA fallback precedence vs `/api` and `/assets`; recorder live semantics
preserved; useAvatarChat race-guard tokens present; cleanup checklist implemented; tag nullable +
CSV RFC-4180; `data/` not web-served; avatar conversation/types match backend responses.
