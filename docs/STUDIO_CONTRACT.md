# Bengali Conversational Eval Studio — FROZEN CONTRACT (v1)

> **SUPERSEDED in three places by later work:** (1) the frontend now lives in the unified `web/`
> app (see [WEB_CONTRACT.md](WEB_CONTRACT.md)), not `studio-web/`; (2) `/` is now the landing
> page, the avatar app is at `/avatar`, and the studio remains at `/studio`; (3) the transcription
> tiers are now `fast` (`gpt-4o-mini-transcribe`) / `best` (`gpt-4o-transcribe`, default) — the
> `whisper`/`whisper-1` and `diarize`/`gpt-4o-transcribe-diarize` tiers were removed (diarize
> romanized Bengali). Everything else below still
> holds.

This document is the **single source of truth**. Backend, frontend, and docs are all
implemented against it. Do **not** invent endpoint names, field names, table names, or JSON
shapes that aren't here. If something is genuinely missing, prefer the closest thing here.

Reconciled from a 6-role codex council (bengali-asr, eval-dataset, sqlite-fastapi,
react-vite-arch, state-rollback, capture-ux) + latest Context7 docs (React 19, Vite, zundo,
RTK Query/TanStack Query).

---

## 0. Goal & guardrails

A voice-first tool to build a **Bengali conversational eval dataset**: Record → Stop →
transcribe (Bengali) → append as a new line to the active "page" (text file). Pages shown as
cards; auto-roll to a new page when full; per-page interactive line editor; durable rollback;
download `.txt` and `.jsonl`.

**Guardrails (do not violate):**
- The existing avatar app at `/avatar` must keep working. Do **not** modify avatar conversation
  behavior, `app/api/routes/conversations.py`, `app/api/routes/health.py`, or the avatar prompts.
- Keep OpenAI access as direct `httpx` (no SDK).
- SQLite DB and audio live under `data/` (created at runtime) — **never** under any
  `StaticFiles` directory and never web-served. `data/` is gitignored.
- New backend code is **additive**: a new `datasets` router + a new `dataset_store` service +
  small additive changes to `openai_gateway.transcribe`, `config.py`, `main.py`, `router.py`.

---

## 1. Transcription tiers (backend)

Tier → model string map (backend authoritative; never trust a raw model string from client):

| tier      | model string              | response_format | timestamps |
|-----------|---------------------------|-----------------|------------|
| `fast`    | `gpt-4o-mini-transcribe`  | `json`          | no         |
| `best`    | `gpt-4o-transcribe`       | `json`          | no         |
| `whisper` | `whisper-1`               | `verbose_json`  | segment    |

- **Default tier = `best`** (eval quality). Frontend may default the selector to `best`.
- Always send `language` (default `"bn"`). Accept override `"bn" | "auto" | "en"`; when value
  is `"auto"`, omit the `language` field entirely. If OpenAI rejects the language with a 4xx
  mentioning language, **retry once without** the `language` field.
- Always send `temperature=0`.
- Send a Bengali **prompt** (versioned). Default prompt id = `bn-codeswitch-v1`:

  ```
  এটি বাংলা কথোপকথনের সংক্ষিপ্ত utterance; মাঝে ইংরেজি tech/code-switch শব্দ থাকতে পারে। যা শোনা যায় শুধু সেটাই লিখুন; না শোনা গেলে খালি রাখুন। বাংলা শব্দ বাংলা লিপিতে লিখুন। ইংরেজি model, product, library, API, code identifier Latin script-এ রাখুন: OpenAI, ChatGPT, API, SQLite, React, Vite, FastAPI, TanStack Query, Zustand, JSON, WebM, Opus, eval, dataset, prompt. কথার filler রাখুন: উম, মানে, আচ্ছা।
  ```

- For `gpt-4o-*` tiers add `include[]=logprobs` (multipart: repeated `include[]` form field).
  whisper-1 uses `timestamp_granularities[]=segment` instead.

### `OpenAIGateway.transcribe` signature (extend, keep backward compatible)

```python
async def transcribe(
    self, *, audio_bytes: bytes, filename: str, content_type: str | None,
    model: str | None = None, language: str | None = None,
    prompt: str | None = None, response_format: str = "json",
    extra_fields: dict[str, str] | None = None,   # e.g. {"temperature": "0"}; repeated keys via list values
) -> dict:  # returns the parsed provider JSON (NOT just text), so callers can read logprobs/segments
```
- Backward-compat: the existing `/api/speech/transcriptions` route keeps returning `{text}`;
  it calls transcribe and reads `["text"]`. Do not break it.
- New code reads `result["text"]` plus optional `result.get("logprobs")` / segments.

Config additions (`app/core/config.py`):
```python
openai_transcribe_model_fast: str = "gpt-4o-mini-transcribe"   # env OPENAI_TRANSCRIBE_MODEL_FAST
openai_transcribe_model_best: str = "gpt-4o-transcribe"        # env OPENAI_TRANSCRIBE_MODEL_BEST
openai_transcribe_model_whisper: str = "whisper-1"             # env OPENAI_TRANSCRIBE_MODEL_WHISPER
data_dir: str = "data"                                         # env DATA_DIR
dataset_page_size_default: int = 50                            # env DATASET_PAGE_SIZE_DEFAULT
```

---

## 2. SQLite schema (authoritative DDL)

DB file: `{data_dir}/studio.db`. On every connection set:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

```sql
CREATE TABLE IF NOT EXISTS series (
  id          TEXT PRIMARY KEY,                 -- "ser_<hex>"
  title       TEXT NOT NULL,
  page_size   INTEGER NOT NULL DEFAULT 50 CHECK (page_size > 0),
  language    TEXT NOT NULL DEFAULT 'bn',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (                 -- one "page" = one downloadable text file = one card
  id                  TEXT PRIMARY KEY,               -- "ds_<hex>"
  series_id           TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  page_no             INTEGER NOT NULL CHECK (page_no >= 1),
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','full','archived')),
  current_revision_id INTEGER,
  deleted_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(series_id, page_no)
);

CREATE TABLE IF NOT EXISTS lines (
  id               TEXT NOT NULL,                      -- "ln_<hex>" (stable line key)
  dataset_id       TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  line_index       INTEGER NOT NULL CHECK (line_index >= 0),  -- 0-based, contiguous among non-deleted
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','assistant','interviewer','system')),
  eval_part        TEXT NOT NULL DEFAULT 'ignored' CHECK (eval_part IN ('prompt','context','expected','ignored')),
  conversation_key TEXT,                               -- groups lines into one example/conversation (nullable)
  turn_index       INTEGER,                            -- 0-based within conversation_key (nullable)
  text             TEXT NOT NULL,                      -- reviewed/gold text (source of truth for export)
  raw_transcript   TEXT,                               -- ASR draft; never overwritten by edits
  source           TEXT NOT NULL DEFAULT 'voice' CHECK (source IN ('voice','manual','import')),
  review_status    TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','accepted','rejected','needs_review')),
  flags_json       TEXT NOT NULL DEFAULT '[]',         -- JSON array of flag strings
  metadata_json    TEXT NOT NULL DEFAULT '{}',         -- stt_model, model_tier, language_requested, stt_prompt_id,
                                                       -- audio_duration_ms, audio_sha256, audio_path, logprob_avg, etc.
  text_hash        TEXT,                               -- sha256 of text
  deleted_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (dataset_id, id),
  UNIQUE (dataset_id, line_index)
);
CREATE INDEX IF NOT EXISTS lines_ds_order ON lines(dataset_id, line_index);

CREATE TABLE IF NOT EXISTS revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id   TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  revision_no  INTEGER NOT NULL,                      -- per-dataset monotonic, starts at 1
  op           TEXT NOT NULL CHECK (op IN
                 ('create','append','edit_line','delete_line','reorder','rename','set_review','rollback')),
  request_id   TEXT,                                  -- idempotency key (client segment / mutation id)
  summary      TEXT NOT NULL DEFAULT '',
  meta_json    TEXT NOT NULL DEFAULT '{}',            -- e.g. {"target_revision_id": 12} for rollback
  created_at   TEXT NOT NULL,
  UNIQUE(dataset_id, revision_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS revisions_request_uq ON revisions(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS revisions_ds ON revisions(dataset_id, id);

-- per-revision full snapshot of the dataset's lines (snapshot-based rollback, NOT event replay)
CREATE TABLE IF NOT EXISTS revision_lines (
  revision_id      INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  line_id          TEXT NOT NULL,
  line_index       INTEGER NOT NULL,
  role             TEXT NOT NULL,
  eval_part        TEXT NOT NULL,
  conversation_key TEXT,
  turn_index       INTEGER,
  text             TEXT NOT NULL,
  raw_transcript   TEXT,
  source           TEXT NOT NULL,
  review_status    TEXT NOT NULL,
  flags_json       TEXT NOT NULL DEFAULT '[]',
  metadata_json    TEXT NOT NULL DEFAULT '{}',
  text_hash        TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (revision_id, line_id)
);

CREATE TABLE IF NOT EXISTS capture_segments (        -- audio-first durability + idempotency
  id            TEXT PRIMARY KEY,                     -- = client segment id (idempotency key)
  dataset_id    TEXT NOT NULL,                        -- originally requested dataset/page
  target_dataset_id TEXT,                             -- actual dataset/page written after auto-roll
  audio_path    TEXT,                                 -- data/audio/<sha>.webm
  audio_sha256  TEXT,
  duration_ms   INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('stored','transcribed','appended','failed')),
  line_id       TEXT,                                 -- set when appended
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

**Write strategy (every mutating op):** acquire app-level async write lock → run sync sqlite
in threadpool (fresh connection, PRAGMas) → `BEGIN IMMEDIATE` → (optional) check
`base_revision_id` matches `datasets.current_revision_id`, else raise Conflict(409) → mutate →
insert `revisions` row (revision_no = prev+1) → copy current non-deleted lines into
`revision_lines` → set `datasets.current_revision_id` → commit.

**Reorder:** client sends the full ordered list of line ids. Validate it's an exact permutation
of current non-deleted line ids (else 409/422). Two-phase update because `UNIQUE(dataset_id,
line_index)`: first set indices to large positive temporary values, then to final `i`.

**Delete line:** soft delete (`deleted_at`), then renumber remaining non-deleted lines to stay
contiguous 0-based (two-phase, same as reorder).

**Rollback:** `POST /rollback {target_revision_id}` → wipe live `lines` for the dataset →
re-insert from `revision_lines` of the target revision → write a new `rollback` revision (with
`meta_json.target_revision_id`) and snapshot. History is never destroyed.

**Auto-roll (append):** if the requested dataset's non-deleted line count >= series.page_size,
mark it `full`, resolve the series landing page, and append there. The landing page is the
highest `page_no` non-deleted page if it has capacity; otherwise create a new page after the
highest `page_no` across all rows in the series, including soft-deleted rows that still reserve
`UNIQUE(series_id, page_no)`. Return both the requested dataset and the dataset actually written
plus `rolled`.

---

## 3. HTTP API (all under `/api`, JSON unless noted)

IDs: `ser_`, `ds_`, `ln_` prefixes. Timestamps ISO-8601 UTC strings.

### Datasets / series
- `GET /api/datasets` → `{ datasets: DatasetCard[] }` (non-deleted, newest series first, then page_no).
- `POST /api/datasets` body `{ title?: string, page_size?: int, language?: string }` →
  creates a new **series** + its first page (page_no=1). Returns `{ dataset: DatasetCard }`.
- `GET /api/datasets/{dataset_id}` → `DatasetDetail` (card + `lines: Line[]` + `revision_count`).
- `PATCH /api/datasets/{dataset_id}` body `{ name?: string, base_revision_id?: int }` (rename).
- `DELETE /api/datasets/{dataset_id}` → soft delete → `204`.

### Capture (primary voice loop — audio-first, idempotent)
- `POST /api/datasets/{dataset_id}/capture` — multipart form:
  - `audio` (file), `client_segment_id` (str, idempotency key, required),
  - `tier` (`fast|best`, default `best`), `language` (`bn|auto|en`, default `bn`),
  - `prompt_id` (default `bn-codeswitch-v1`), `auto_roll` (`true|false`, default `true`),
  - `role` (`user|assistant|interviewer|system`, default `user`), `eval_part`
    (`prompt|context|expected|ignored`, default `ignored`), `tag` (optional),
  - `conversation_key` (optional), `turn_index` (optional int), `duration_ms` (optional int).
  - `tier`/`language`/`role`/`eval_part` are enum-validated at parse time → **422 before any
    side effect**. Both tiers send the Bengali prompt + logprobs.
  - Flow: **validate enums (422) → check dataset exists (404) → reject empty audio (400) →**
    persist audio under `data/audio/` → upsert `capture_segments` (idempotent) → transcribe →
    append line (+ auto-roll) in one tx → return `AppendResult`. Validation precedes the OpenAI
    call so a bad request never wastes a transcription.
  - If `client_segment_id` already `appended`, return the existing `AppendResult` (no dup).
  - On transcription failure: segment stays `failed`/`stored`; return `502` with
    `{ detail, client_segment_id }`; audio retained for retry.

### Lines (manual edits)
- `POST /api/datasets/{dataset_id}/lines` body `{ text, role?, eval_part?, conversation_key?, turn_index?, base_revision_id? }` (manual add) → `AppendResult`.
- `PATCH /api/datasets/{dataset_id}/lines/{line_id}` body `{ text?, role?, eval_part?, conversation_key?, turn_index?, review_status?, flags?, base_revision_id? }` → `{ dataset: DatasetCard, line: Line, revision_id }`.
- `DELETE /api/datasets/{dataset_id}/lines/{line_id}?base_revision_id=` → `{ dataset, revision_id }`.
- `PATCH /api/datasets/{dataset_id}/reorder` body `{ line_ids: string[], base_revision_id? }` → `{ dataset, revision_id }`.

### Revisions / rollback
- `GET /api/datasets/{dataset_id}/revisions` → `{ revisions: Revision[] }` (newest first).
- `POST /api/datasets/{dataset_id}/rollback` body `{ target_revision_id: int }` → `DatasetDetail`.

### Downloads (endpoint-shaped, never filename-from-client)
- `GET /api/datasets/{dataset_id}/download?format=txt&annotated=false` →
  `text/plain` attachment. `annotated=true` prefixes `[role] `. Only non-deleted lines.
- `GET /api/datasets/{dataset_id}/download?format=jsonl&scope=accepted` →
  `application/x-ndjson` attachment. Groups by `conversation_key` (null key = one line per
  example). Shape per line:
  ```json
  {"id":"ex_<key>","messages":[{"role":"user","content":"..."}],
   "expected":{"role":"assistant","content":"..."},
   "metadata":{"dataset_id":"ds_..","language":"bn","stt_model":"gpt-4o-transcribe","line_ids":["ln_.."]}}
  ```
  `scope`=`accepted` (default) exports only `review_status='accepted'`; `all` exports all
  non-deleted. Lines with `eval_part='ignored'` and null conversation_key export as a single
  `{"messages":[{"role":<role>,"content":text}]}` (no `expected`).

### Config (extend existing `/api/config` — additive, don't remove fields)
Add: `transcribe_tiers: [{id, label, model}]`, `stt_prompts: [{id, label}]`, `languages: ["bn","auto","en"]`, `dataset_page_size_default: int`.

### Error shape
Reuse existing `OpenAIServiceError`/`as_http_error`. Add a `ConflictError` → `409`
`{detail:{message, code:"revision_conflict", current_revision_id}}` for stale `base_revision_id`.

---

## 4. TypeScript types (frontend — mirror exactly)

```ts
export type Tier = 'fast' | 'best' | 'whisper';
export type Role = 'user' | 'assistant' | 'interviewer' | 'system';
export type EvalPart = 'prompt' | 'context' | 'expected' | 'ignored';
export type ReviewStatus = 'unreviewed' | 'accepted' | 'rejected' | 'needs_review';

export interface DatasetCard {
  id: string; series_id: string; page_no: number; name: string;
  status: 'active' | 'full' | 'archived';
  line_count: number; page_size: number; current_revision_id: number | null;
  language: string; created_at: string; updated_at: string;
}
export interface Line {
  id: string; dataset_id: string; line_index: number; role: Role; eval_part: EvalPart;
  conversation_key: string | null; turn_index: number | null;
  text: string; raw_transcript: string | null; source: 'voice'|'manual'|'import';
  review_status: ReviewStatus; flags: string[];
  metadata: Record<string, unknown>; created_at: string; updated_at: string;
}
export interface DatasetDetail extends DatasetCard { lines: Line[]; revision_count: number; }
export interface Revision { id: number; revision_no: number; op: string; summary: string;
  meta: Record<string, unknown>; created_at: string; }
export interface AppendResult {
  requested_dataset_id: string; dataset_id: string; rolled: boolean;
  line: Line; dataset: DatasetCard; revision_id: number;
}
```

---

## 5. Frontend app layout (`studio-web/`, React 19 + Vite + TS + TanStack Query + zundo)

```
studio-web/
  package.json            # react, react-dom, @tanstack/react-query, zustand, zundo, vite, @vitejs/plugin-react, typescript, @types/*
  tsconfig.json
  vite.config.ts          # base:'/studio/', plugins:[react()], server.proxy '/api'->http://127.0.0.1:8000, build.outDir:'dist'
  index.html
  src/
    main.tsx              # mounts <App/> in QueryClientProvider (staleTime ~5s, refetchOnWindowFocus:false, retry:1)
    App.tsx               # StudioApp shell + header (link back to avatar app at '/avatar')
    api/client.ts         # typed fetch helpers (root-relative /api/...), FormData for capture
    api/queries.ts        # TanStack hooks: useDatasets, useDataset, useRevisions + mutations
                          #   (useCapture, useAddLine, useEditLine, useDeleteLine, useReorder,
                          #    useRollback, useCreateDataset, useRenameDataset, useDeleteDataset)
                          #   query keys: ['datasets'], ['dataset',id], ['dataset',id,'revisions']
    features/recording/useRecorder.ts   # reducer-based hook; PORT logic from frontend/src/audio/recorder.js
                          #   (getUserMedia, MediaRecorder 'audio/webm;codecs=opus', RMS level, cleanup on unmount)
                          #   states: idle|requesting_mic|recording|stopping; returns {state, level, start, stop, blob, durationMs}
    features/editor/draftStore.ts       # zustand + zundo temporal({limit:50, partialize}) for UNSAVED line-edit drafts only
    components/RecordBar.tsx     # big Record/Stop (Space hotkey), tier select, language select, "Appending to: Page NN · x/y · auto-roll"
    components/ModelTierSelect.tsx
    components/FileCardFeed.tsx  # grid/list of FileCard
    components/FileCard.tsx      # name, line_count/page_size, reviewed count, active marker, open, download txt/jsonl, rename, delete
    components/LineEditor.tsx    # list of lines: inline edit, role/eval_part controls, review accept/reject, delete+undo, reorder up/down, add line, re-... (manual)
    components/RollbackTimeline.tsx     # lists revisions; preview + rollback (confirm on deep rollback)
    components/PendingQueue.tsx  # shows in-flight/failed captures with retry (retry same / retry Best / edit / discard)
  README.md
```

**Behavior rules (from council):**
- Default tier selector to **best**; Fast is a sticky preference.
- Capture loop: on Stop → optimistic pending row (temp id) → `useCapture` mutation with
  `client_segment_id` (generated at record start) → on success replace pending row + invalidate
  `['dataset',id]` + `['datasets']` + `['dataset',id,'revisions']`; on error keep pending row
  with retry options. **Never discard the audio blob until the server confirms append.**
- Append immediately as `unreviewed`, highlight new row, one-click Undo/Edit/Delete.
- zundo only wraps unsaved editor drafts; durable rollback is the server revisions endpoint.
  After a successful append/save/rollback, `clear()` the local temporal history.
- Space toggles record only when focus is not in an input/textarea/contenteditable.
- Auto-roll surfaced: after `rolled:true`, switch active target to returned dataset + toast
  "Page NNN created".
- Warn on `.txt`/`.jsonl` download if unreviewed lines exist (offer "all" vs "accepted only").
- All API calls are **root-relative** `/api/...` (dev proxy handles it; prod same origin).

---

## 6. Backend wiring (`app/main.py`, additive)

Mount order MUST be: `app.include_router(api_router)` (already) → then mount the studio build
**before** the existing root mount:
```python
STUDIO_DIST = ROOT / "studio-web" / "dist"
if STUDIO_DIST.exists():
    app.mount("/studio", StaticFiles(directory=STUDIO_DIST, html=True), name="studio")
# existing root mount stays LAST:
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
```
Register `datasets.router` in `app/api/router.py`. Create the dataset store + ensure
`data/` dirs at startup (lifespan), store on `app.state.dataset_store`. Add a dependency
`dataset_store(request)` in `app/api/dependencies.py` mirroring `openai_gateway`.

`.gitignore`: add `data/` and `studio-web/node_modules/` and `studio-web/dist/`.

---

## 7. Verification gates (Phase Verify)
- Backend: `python -c "import app.main"` imports clean; a small script creates a series, appends
  lines (mocking OpenAI by calling the store directly), edits, reorders, deletes, rolls back,
  and exports txt+jsonl — asserting line_index contiguity and rollback correctness.
- Frontend: `cd studio-web && npm install && npm run build` (tsc + vite) succeeds with no type
  errors and emits `dist/`.
