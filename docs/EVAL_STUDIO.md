# Bengali Conversational Eval Studio

A voice-first tool for building a Bengali conversational eval dataset. Record → Stop →
transcribe (Bengali) → append the transcript as a new line on the active page; review, edit,
reorder, roll back, and export.

This guide describes the architecture and the conceptual model. The authoritative endpoint and
schema definitions are in [STUDIO_CONTRACT.md](STUDIO_CONTRACT.md) — this document does not add
new endpoints or fields. To run it, see the "Bengali Conversational Eval Studio" section of the
[README](../README.md).

## Architecture

### SQLite as the source of truth

All durable state lives in `data/studio.db` (created at runtime, gitignored, never web-served).
The schema is organized around a few tables:

- `series` — a titled group of pages with a fixed `page_size` and `language`.
- `datasets` — one "page" = one downloadable text file = one card. Pages are numbered
  (`page_no`) within a series and carry a `status` (`active` / `full` / `archived`) and a
  pointer to their `current_revision_id`.
- `lines` — the reviewed/gold lines of a page. `line_index` is 0-based and kept contiguous
  among non-deleted lines. `text` is the source of truth for export; `raw_transcript` keeps the
  original ASR draft and is never overwritten by edits.

Every mutating operation runs under an app-level write lock with a fresh sqlite connection
(`PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`) inside a
`BEGIN IMMEDIATE` transaction, so writes are serialized and crash-safe.

### Revisions and snapshots (durable rollback)

Rollback is **snapshot-based, not event replay**. Each mutating op appends a `revisions` row
(per-dataset monotonic `revision_no`, an `op` label, and a `meta_json` blob) and copies the full
set of current non-deleted lines into `revision_lines`. The page's `current_revision_id` then
points at that new revision.

Because every revision carries a complete snapshot of the page's lines, rolling back is a direct
restore (see the rollback model below) rather than replaying a log. History is never destroyed —
a rollback itself is recorded as a new `rollback` revision.

Optimistic concurrency is handled by `base_revision_id`: a mutation can include the revision the
client based its edit on; if it no longer matches `datasets.current_revision_id`, the write is
rejected as a revision conflict instead of silently clobbering newer state.

### Frontend (React / Vite / TanStack Query / zundo)

The studio is the `studio` feature of the unified `web/` app (React 19 + Vite + TypeScript),
served at `/studio` and lazy-loaded so it never pulls Aria's Three.js code from `/avatar`. See
[WEB_ARCHITECTURE.md](WEB_ARCHITECTURE.md) for the overall frontend layout. Within that app:

- **TanStack Query** owns server state: datasets, a single dataset's detail, and its revisions,
  plus all mutations (capture, add/edit/delete/reorder line, rollback, create/rename/delete
  dataset). Successful mutations invalidate the relevant query keys so the UI reflects the new
  server revision.
- **zustand + zundo** (`temporal`) provide local undo/redo for **unsaved line-edit drafts only**.
  This in-memory history is distinct from durable rollback; after a successful append, save, or
  rollback, the local temporal history is cleared. Durable rollback is always the server
  revisions endpoint.
- All API calls are root-relative (`/api/...`): the Vite dev proxy handles them in dev, and the
  same origin (FastAPI serving `web/dist`) serves them in prod.

### Capture-segment audio-first flow

The primary voice loop is **audio-first and idempotent**. On Stop, the recorded blob is sent
with a `client_segment_id` generated at record start. The backend persists the audio under
`data/audio/`, upserts a `capture_segments` row (keyed by that id), transcribes, and appends the
line within one transaction.

Key durability properties:

- The audio blob is never discarded until the server confirms the append.
- If the same `client_segment_id` is sent again after it already `appended`, the existing result
  is returned — no duplicate line.
- On transcription failure the segment stays `stored` / `failed` and the audio is retained, so
  the capture can be retried (retry same tier, retry on Best, edit, or discard).

## Conversational schema

Each line carries the fields that make a page exportable as a conversational eval set:

- **`role`** — `user` | `assistant` | `interviewer` | `system`.
- **`eval_part`** — `prompt` | `context` | `expected` | `ignored`. This marks how a line
  participates in an example: input-side material vs. the gold answer vs. lines excluded from
  structured export.
- **`conversation_key`** — groups multiple lines into a single example/conversation. Lines that
  share a key form one multi-turn example; `turn_index` orders the turns within that key.

Other per-line fields support review and provenance: `review_status`
(`unreviewed` / `accepted` / `rejected` / `needs_review`), `flags`, `source`
(`voice` / `manual` / `import`), and a `metadata` blob (STT model, tier, requested language,
prompt id, audio duration/sha/path, logprob average, etc.).

### Per-line tag

Each line also carries an optional, nullable **`tag`** (`tag: string | null`) — a free-text label
(for example `greeting`). It is independent of `role` / `eval_part` and exists purely for
flat-table labeling and the CSV export.

- **Storage:** `tag TEXT` (nullable, default `NULL`) on both `lines` and `revision_lines`, so the
  tag is snapshotted with the line and survives rollback. Empty or whitespace-only input is stored
  as `NULL`.
- **API:** `tag` is accepted as an optional field on `POST .../capture`, `POST .../lines`, and
  `PATCH .../lines/{id}`, and is returned on `Line`. See
  [STUDIO_CONTRACT.md](STUDIO_CONTRACT.md) §6.
- **Frontend:** one sticky tag text box in the record bar (applied as the `tag` of each capture,
  `null` when empty) and an editable tag field per row in the line editor.

### How `.jsonl` export groups lines

The `.jsonl` download groups by `conversation_key` and shapes each example into a
messages-plus-expected record. Conceptually:

- Lines sharing a `conversation_key` become one example: input-side lines (e.g. `prompt` /
  `context`) become the `messages` array, and an `expected` line becomes the gold answer.
- A line with `eval_part='ignored'` and a null `conversation_key` exports as a single
  `{"messages":[{"role":<role>,"content":<text>}]}` record with no `expected`.
- `scope=accepted` (default) exports only `review_status='accepted'` lines; `scope=all` exports
  all non-deleted lines.

See STUDIO_CONTRACT.md §3 for the exact JSON shape and metadata fields.

### CSV export (`text,tagname`)

Alongside `.txt` and `.jsonl`, a page exports as a flat `.csv` for spreadsheet and labeling tools:
`GET /api/datasets/{dataset_id}/download?format=csv&scope=all` →
`text/csv; charset=utf-8` attachment.

- **Columns:** a header row `text,tagname`, then one row per non-deleted line in `line_index`
  order. `tagname` is the line's `tag` (empty when the tag is `NULL`).
- **RFC-4180 quoting:** every field is wrapped in double quotes, and any embedded double quote is
  doubled (`""`). A null tag is emitted as an empty quoted field `""`. UTF-8 (Bengali) text is
  preserved.
- **Scope:** `all` (default, all non-deleted lines) or `accepted` (`review_status='accepted'`),
  mirroring the txt/jsonl scope handling.

Example output:

```csv
text,tagname
"আজ তুমি কেমন আছো?","greeting"
"আমি ভালো আছি, ""সত্যিই""।",""
```

The second row shows both rules at once: the line's text contains a literal `"সত্যিই"`, so each
inner quote is doubled inside the quoted field, and the line has no tag, so `tagname` is `""`.

See STUDIO_CONTRACT.md §6 for the authoritative endpoint, quoting, and smoke-test requirements.

## Rollback model

1. Pick a `target_revision_id` from the page's revision history (newest first).
2. The server wipes the live `lines` for that dataset and re-inserts them from the
   `revision_lines` snapshot of the target revision.
3. A new `rollback` revision is written (with `meta_json.target_revision_id`) and snapshotted,
   so the rollback is itself part of the history and can be rolled past or away from later.

Nothing is permanently lost: rollback is a forward-moving restore, not a deletion of newer
revisions. The frontend's `RollbackTimeline` lists revisions, supports preview, and confirms on
deep rollbacks; local zundo undo/redo is unrelated to this and only covers unsaved drafts.

## Bengali STT guidance

Transcription is tuned for Bengali conversational utterances with English code-switching:

- **Language:** always send `language` (default `"bn"`). Override values are `"bn" | "auto" | "en"`.
  When the value is `"auto"`, the `language` field is omitted entirely. If OpenAI rejects the
  language with a 4xx mentioning language, the request is retried once without the `language`
  field.
- **Prompt:** a versioned Bengali prompt steers script and code-switch behavior. The default is
  `bn-codeswitch-v1`, which instructs the model to write Bengali words in Bengali script, keep
  English tech/product/library/API identifiers in Latin script (OpenAI, ChatGPT, API, SQLite,
  React, Vite, FastAPI, TanStack Query, Zustand, JSON, WebM, Opus, eval, dataset, prompt), and
  preserve conversational fillers (উম, মানে, আচ্ছা).
- **Determinism:** `temperature=0` on every request.
- **Hallucination gating:** the prompt explicitly tells the model to transcribe only what is
  audible and to leave the output empty when nothing is heard, rather than inventing plausible
  Bengali. Tier choice supports this — `best` (`gpt-4o-transcribe`) is the default for eval
  quality, and the `fast`/`best` `gpt-4o-*` tiers request logprobs so the recorded `metadata`
  can carry a logprob average for downstream confidence review. The `diarize`
  (`gpt-4o-transcribe-diarize`) tier is speaker-aware but rejects `prompt`/`include[]`, so it
  romanizes Bengali — prefer `best` for Bengali-script text, use `diarize` for multi-speaker.

Because the original ASR draft is preserved in each line's `raw_transcript` and never overwritten
by edits, reviewers can always compare the gold `text` against what the model actually produced.
