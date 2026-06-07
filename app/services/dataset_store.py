from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.core.errors import ConflictError, OpenAIServiceError
from fastapi import status


# ---------------------------------------------------------------------------
# DDL (authoritative, contract section 2)
# ---------------------------------------------------------------------------
_DDL = """
CREATE TABLE IF NOT EXISTS series (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  page_size   INTEGER NOT NULL DEFAULT 50 CHECK (page_size > 0),
  language    TEXT NOT NULL DEFAULT 'bn',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id                  TEXT PRIMARY KEY,
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
  id               TEXT NOT NULL,
  dataset_id       TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  line_index       INTEGER NOT NULL CHECK (line_index >= 0),
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','assistant','interviewer','system')),
  eval_part        TEXT NOT NULL DEFAULT 'ignored' CHECK (eval_part IN ('prompt','context','expected','ignored')),
  conversation_key TEXT,
  turn_index       INTEGER,
  text             TEXT NOT NULL,
  raw_transcript   TEXT,
  source           TEXT NOT NULL DEFAULT 'voice' CHECK (source IN ('voice','manual','import')),
  review_status    TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','accepted','rejected','needs_review')),
  flags_json       TEXT NOT NULL DEFAULT '[]',
  metadata_json    TEXT NOT NULL DEFAULT '{}',
  text_hash        TEXT,
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
  revision_no  INTEGER NOT NULL,
  op           TEXT NOT NULL CHECK (op IN
                 ('create','append','edit_line','delete_line','reorder','rename','set_review','rollback')),
  request_id   TEXT,
  summary      TEXT NOT NULL DEFAULT '',
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  UNIQUE(dataset_id, revision_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS revisions_request_uq ON revisions(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS revisions_ds ON revisions(dataset_id, id);

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

CREATE TABLE IF NOT EXISTS capture_segments (
  id            TEXT PRIMARY KEY,
  dataset_id    TEXT NOT NULL,
  audio_path    TEXT,
  audio_sha256  TEXT,
  duration_ms   INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('stored','transcribed','appended','failed')),
  line_id       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
"""

_PRAGMAS = (
    "PRAGMA journal_mode = WAL;",
    "PRAGMA synchronous = FULL;",
    "PRAGMA foreign_keys = ON;",
    "PRAGMA busy_timeout = 5000;",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class NotFoundError(Exception):
    pass


class DatasetStore:
    """SQLite-backed store for the Bengali eval studio.

    All sync sqlite work happens in a threadpool; a single asyncio.Lock serializes writes
    so BEGIN IMMEDIATE never collides with another writer in this process.
    """

    def __init__(self, data_dir: str | Path, page_size_default: int = 50) -> None:
        self.data_dir = Path(data_dir)
        self.audio_dir = self.data_dir / "audio"
        self.db_path = self.data_dir / "studio.db"
        self.page_size_default = page_size_default
        self._write_lock = asyncio.Lock()

    # -- lifecycle ---------------------------------------------------------
    def _ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), isolation_level=None)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        for pragma in _PRAGMAS:
            cur.execute(pragma)
        cur.close()
        return conn

    def _init_db_sync(self) -> None:
        self._ensure_dirs()
        conn = self._connect()
        try:
            conn.executescript(_DDL)
        finally:
            conn.close()

    async def initialize(self) -> None:
        await run_in_threadpool(self._init_db_sync)

    # -- row mapping -------------------------------------------------------
    @staticmethod
    def _card_from_rows(ds: sqlite3.Row, series: sqlite3.Row, line_count: int) -> dict[str, Any]:
        return {
            "id": ds["id"],
            "series_id": ds["series_id"],
            "page_no": ds["page_no"],
            "name": ds["name"],
            "status": ds["status"],
            "line_count": line_count,
            "page_size": series["page_size"],
            "current_revision_id": ds["current_revision_id"],
            "language": series["language"],
            "created_at": ds["created_at"],
            "updated_at": ds["updated_at"],
        }

    @staticmethod
    def _line_from_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "dataset_id": row["dataset_id"],
            "line_index": row["line_index"],
            "role": row["role"],
            "eval_part": row["eval_part"],
            "conversation_key": row["conversation_key"],
            "turn_index": row["turn_index"],
            "text": row["text"],
            "raw_transcript": row["raw_transcript"],
            "source": row["source"],
            "review_status": row["review_status"],
            "flags": json.loads(row["flags_json"] or "[]"),
            "metadata": json.loads(row["metadata_json"] or "{}"),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # -- low-level helpers (run inside a transaction) ----------------------
    @staticmethod
    def _line_count(conn: sqlite3.Connection, dataset_id: str) -> int:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM lines WHERE dataset_id = ? AND deleted_at IS NULL",
            (dataset_id,),
        ).fetchone()
        return int(row["c"])

    @staticmethod
    def _get_dataset_row(conn: sqlite3.Connection, dataset_id: str, *, include_deleted: bool = False) -> sqlite3.Row:
        row = conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
        if row is None or (not include_deleted and row["deleted_at"] is not None):
            raise NotFoundError(f"dataset {dataset_id} not found")
        return row

    @staticmethod
    def _get_series_row(conn: sqlite3.Connection, series_id: str) -> sqlite3.Row:
        row = conn.execute("SELECT * FROM series WHERE id = ?", (series_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"series {series_id} not found")
        return row

    def _card(self, conn: sqlite3.Connection, dataset_id: str) -> dict[str, Any]:
        ds = self._get_dataset_row(conn, dataset_id)
        series = self._get_series_row(conn, ds["series_id"])
        return self._card_from_rows(ds, series, self._line_count(conn, dataset_id))

    def _check_base_revision(self, conn: sqlite3.Connection, ds: sqlite3.Row, base_revision_id: int | None) -> None:
        if base_revision_id is None:
            return
        current = ds["current_revision_id"]
        if current != base_revision_id:
            raise ConflictError(current_revision_id=current)

    def _next_revision_no(self, conn: sqlite3.Connection, dataset_id: str) -> int:
        row = conn.execute(
            "SELECT COALESCE(MAX(revision_no), 0) AS m FROM revisions WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()
        return int(row["m"]) + 1

    def _write_revision(
        self,
        conn: sqlite3.Connection,
        dataset_id: str,
        op: str,
        *,
        summary: str = "",
        meta: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> int:
        """Insert a revisions row, snapshot current non-deleted lines, set current_revision_id."""
        now = _now()
        revision_no = self._next_revision_no(conn, dataset_id)
        cur = conn.execute(
            "INSERT INTO revisions (dataset_id, revision_no, op, request_id, summary, meta_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (dataset_id, revision_no, op, request_id, summary, json.dumps(meta or {}), now),
        )
        revision_id = int(cur.lastrowid)
        rows = conn.execute(
            "SELECT * FROM lines WHERE dataset_id = ? AND deleted_at IS NULL ORDER BY line_index",
            (dataset_id,),
        ).fetchall()
        for r in rows:
            conn.execute(
                "INSERT INTO revision_lines (revision_id, line_id, line_index, role, eval_part, conversation_key, "
                "turn_index, text, raw_transcript, source, review_status, flags_json, metadata_json, text_hash, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    revision_id, r["id"], r["line_index"], r["role"], r["eval_part"], r["conversation_key"],
                    r["turn_index"], r["text"], r["raw_transcript"], r["source"], r["review_status"],
                    r["flags_json"], r["metadata_json"], r["text_hash"], now,
                ),
            )
        conn.execute(
            "UPDATE datasets SET current_revision_id = ?, updated_at = ? WHERE id = ?",
            (revision_id, now, dataset_id),
        )
        return revision_id

    # Large positive offset for phase-1 temporary indices: dodges UNIQUE(dataset_id,
    # line_index) while still satisfying the CHECK(line_index >= 0) constraint.
    _TEMP_OFFSET = 1_000_000_000

    def _renumber_contiguous(self, conn: sqlite3.Connection, dataset_id: str) -> None:
        """Two-phase renumber of non-deleted lines to contiguous 0-based indices."""
        rows = conn.execute(
            "SELECT id FROM lines WHERE dataset_id = ? AND deleted_at IS NULL ORDER BY line_index",
            (dataset_id,),
        ).fetchall()
        # phase 1: large positive temporary indices to dodge UNIQUE(dataset_id, line_index)
        for i, r in enumerate(rows):
            conn.execute(
                "UPDATE lines SET line_index = ? WHERE dataset_id = ? AND id = ?",
                (self._TEMP_OFFSET + i, dataset_id, r["id"]),
            )
        # phase 2: final indices
        for i, r in enumerate(rows):
            conn.execute(
                "UPDATE lines SET line_index = ? WHERE dataset_id = ? AND id = ?",
                (i, dataset_id, r["id"]),
            )

    # -- public read methods ----------------------------------------------
    async def list_datasets(self) -> list[dict[str, Any]]:
        def work() -> list[dict[str, Any]]:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT d.*, s.created_at AS s_created FROM datasets d "
                    "JOIN series s ON s.id = d.series_id "
                    "WHERE d.deleted_at IS NULL "
                    "ORDER BY s.created_at DESC, d.page_no ASC"
                ).fetchall()
                out: list[dict[str, Any]] = []
                for ds in rows:
                    series = self._get_series_row(conn, ds["series_id"])
                    out.append(self._card_from_rows(ds, series, self._line_count(conn, ds["id"])))
                return out
            finally:
                conn.close()

        return await run_in_threadpool(work)

    async def get_dataset_detail(self, dataset_id: str) -> dict[str, Any]:
        def work() -> dict[str, Any]:
            conn = self._connect()
            try:
                card = self._card(conn, dataset_id)
                line_rows = conn.execute(
                    "SELECT * FROM lines WHERE dataset_id = ? AND deleted_at IS NULL ORDER BY line_index",
                    (dataset_id,),
                ).fetchall()
                rev_row = conn.execute(
                    "SELECT COUNT(*) AS c FROM revisions WHERE dataset_id = ?", (dataset_id,)
                ).fetchone()
                detail = dict(card)
                detail["lines"] = [self._line_from_row(r) for r in line_rows]
                detail["revision_count"] = int(rev_row["c"])
                return detail
            finally:
                conn.close()

        return await run_in_threadpool(work)

    async def get_card(self, dataset_id: str) -> dict[str, Any]:
        def work() -> dict[str, Any]:
            conn = self._connect()
            try:
                return self._card(conn, dataset_id)
            finally:
                conn.close()

        return await run_in_threadpool(work)

    async def list_revisions(self, dataset_id: str) -> list[dict[str, Any]]:
        def work() -> list[dict[str, Any]]:
            conn = self._connect()
            try:
                self._get_dataset_row(conn, dataset_id)
                rows = conn.execute(
                    "SELECT * FROM revisions WHERE dataset_id = ? ORDER BY revision_no DESC",
                    (dataset_id,),
                ).fetchall()
                return [
                    {
                        "id": r["id"],
                        "revision_no": r["revision_no"],
                        "op": r["op"],
                        "summary": r["summary"],
                        "meta": json.loads(r["meta_json"] or "{}"),
                        "created_at": r["created_at"],
                    }
                    for r in rows
                ]
            finally:
                conn.close()

        return await run_in_threadpool(work)

    # -- create series + first page ---------------------------------------
    async def create_series(
        self, *, title: str | None, page_size: int | None, language: str | None
    ) -> dict[str, Any]:
        async with self._write_lock:
            return await run_in_threadpool(self._create_series_sync, title, page_size, language)

    def _create_series_sync(
        self, title: str | None, page_size: int | None, language: str | None
    ) -> dict[str, Any]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            now = _now()
            series_id = _new_id("ser")
            ps = int(page_size) if page_size else self.page_size_default
            lang = language or "bn"
            ser_title = (title or "").strip() or f"Eval series {now[:10]}"
            conn.execute(
                "INSERT INTO series (id, title, page_size, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (series_id, ser_title, ps, lang, now, now),
            )
            dataset_id = _new_id("ds")
            name = self._page_name(ser_title, 1)
            conn.execute(
                "INSERT INTO datasets (id, series_id, page_no, name, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'active', ?, ?)",
                (dataset_id, series_id, 1, name, now, now),
            )
            self._write_revision(conn, dataset_id, "create", summary=f"Created page 1 of {ser_title}")
            card = self._card(conn, dataset_id)
            conn.execute("COMMIT")
            return card
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    @staticmethod
    def _page_name(series_title: str, page_no: int) -> str:
        return f"{series_title} {page_no:03d}"

    # -- rename -----------------------------------------------------------
    async def rename_dataset(
        self, dataset_id: str, *, name: str | None, base_revision_id: int | None
    ) -> dict[str, Any]:
        async with self._write_lock:
            return await run_in_threadpool(self._rename_sync, dataset_id, name, base_revision_id)

    def _rename_sync(self, dataset_id: str, name: str | None, base_revision_id: int | None) -> dict[str, Any]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ds = self._get_dataset_row(conn, dataset_id)
            self._check_base_revision(conn, ds, base_revision_id)
            new_name = (name or "").strip()
            if new_name:
                conn.execute(
                    "UPDATE datasets SET name = ?, updated_at = ? WHERE id = ?",
                    (new_name, _now(), dataset_id),
                )
            self._write_revision(conn, dataset_id, "rename", summary=f"Renamed to {new_name or ds['name']}")
            card = self._card(conn, dataset_id)
            conn.execute("COMMIT")
            return card
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- soft delete dataset ----------------------------------------------
    async def delete_dataset(self, dataset_id: str) -> None:
        async with self._write_lock:
            await run_in_threadpool(self._delete_dataset_sync, dataset_id)

    def _delete_dataset_sync(self, dataset_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ds = self._get_dataset_row(conn, dataset_id)
            conn.execute(
                "UPDATE datasets SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ?",
                (_now(), _now(), dataset_id),
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- append a line (with auto-roll) -----------------------------------
    async def append(
        self,
        dataset_id: str,
        *,
        text: str,
        role: str = "user",
        eval_part: str = "ignored",
        conversation_key: str | None = None,
        turn_index: int | None = None,
        raw_transcript: str | None = None,
        source: str = "voice",
        metadata: dict[str, Any] | None = None,
        review_status: str = "unreviewed",
        flags: list[str] | None = None,
        base_revision_id: int | None = None,
        auto_roll: bool = True,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        async with self._write_lock:
            return await run_in_threadpool(
                self._append_sync,
                dataset_id,
                text,
                role,
                eval_part,
                conversation_key,
                turn_index,
                raw_transcript,
                source,
                metadata,
                review_status,
                flags,
                base_revision_id,
                auto_roll,
                request_id,
            )

    def _append_sync(
        self,
        dataset_id: str,
        text: str,
        role: str,
        eval_part: str,
        conversation_key: str | None,
        turn_index: int | None,
        raw_transcript: str | None,
        source: str,
        metadata: dict[str, Any] | None,
        review_status: str,
        flags: list[str] | None,
        base_revision_id: int | None,
        auto_roll: bool,
        request_id: str | None,
    ) -> dict[str, Any]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            requested_dataset_id = dataset_id
            ds = self._get_dataset_row(conn, dataset_id)
            self._check_base_revision(conn, ds, base_revision_id)
            series = self._get_series_row(conn, ds["series_id"])

            rolled = False
            target_id = dataset_id
            if auto_roll and self._line_count(conn, dataset_id) >= series["page_size"]:
                target_id = self._roll_to_next_page(conn, ds, series)
                rolled = True

            line = self._insert_line(
                conn,
                target_id,
                text=text,
                role=role,
                eval_part=eval_part,
                conversation_key=conversation_key,
                turn_index=turn_index,
                raw_transcript=raw_transcript,
                source=source,
                metadata=metadata,
                review_status=review_status,
                flags=flags,
            )
            revision_id = self._write_revision(
                conn,
                target_id,
                "append",
                summary=f"Appended line {line['line_index']}",
                request_id=request_id,
            )
            card = self._card(conn, target_id)
            line_row = self._line_from_row(
                conn.execute(
                    "SELECT * FROM lines WHERE dataset_id = ? AND id = ?", (target_id, line["id"])
                ).fetchone()
            )
            conn.execute("COMMIT")
            return {
                "requested_dataset_id": requested_dataset_id,
                "dataset_id": target_id,
                "rolled": rolled,
                "line": line_row,
                "dataset": card,
                "revision_id": revision_id,
            }
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def _roll_to_next_page(self, conn: sqlite3.Connection, ds: sqlite3.Row, series: sqlite3.Row) -> str:
        now = _now()
        conn.execute(
            "UPDATE datasets SET status = 'full', updated_at = ? WHERE id = ?",
            (now, ds["id"]),
        )
        next_page = int(ds["page_no"]) + 1
        new_id = _new_id("ds")
        name = self._page_name(series["title"], next_page)
        conn.execute(
            "INSERT INTO datasets (id, series_id, page_no, name, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 'active', ?, ?)",
            (new_id, ds["series_id"], next_page, name, now, now),
        )
        self._write_revision(conn, new_id, "create", summary=f"Created page {next_page} (auto-roll)")
        return new_id

    def _insert_line(
        self,
        conn: sqlite3.Connection,
        dataset_id: str,
        *,
        text: str,
        role: str,
        eval_part: str,
        conversation_key: str | None,
        turn_index: int | None,
        raw_transcript: str | None,
        source: str,
        metadata: dict[str, Any] | None,
        review_status: str,
        flags: list[str] | None,
    ) -> dict[str, Any]:
        now = _now()
        line_id = _new_id("ln")
        row = conn.execute(
            "SELECT COALESCE(MAX(line_index), -1) AS m FROM lines WHERE dataset_id = ? AND deleted_at IS NULL",
            (dataset_id,),
        ).fetchone()
        line_index = int(row["m"]) + 1
        conn.execute(
            "INSERT INTO lines (id, dataset_id, line_index, role, eval_part, conversation_key, turn_index, text, "
            "raw_transcript, source, review_status, flags_json, metadata_json, text_hash, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                line_id, dataset_id, line_index, role, eval_part, conversation_key, turn_index, text,
                raw_transcript, source, review_status, json.dumps(flags or []), json.dumps(metadata or {}),
                _sha256_text(text), now, now,
            ),
        )
        return {"id": line_id, "line_index": line_index}

    # -- edit line --------------------------------------------------------
    async def edit_line(
        self,
        dataset_id: str,
        line_id: str,
        *,
        fields: dict[str, Any],
        base_revision_id: int | None,
    ) -> dict[str, Any]:
        async with self._write_lock:
            return await run_in_threadpool(self._edit_line_sync, dataset_id, line_id, fields, base_revision_id)

    def _edit_line_sync(
        self, dataset_id: str, line_id: str, fields: dict[str, Any], base_revision_id: int | None
    ) -> dict[str, Any]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ds = self._get_dataset_row(conn, dataset_id)
            self._check_base_revision(conn, ds, base_revision_id)
            existing = conn.execute(
                "SELECT * FROM lines WHERE dataset_id = ? AND id = ? AND deleted_at IS NULL",
                (dataset_id, line_id),
            ).fetchone()
            if existing is None:
                raise NotFoundError(f"line {line_id} not found")

            now = _now()
            sets: list[str] = []
            params: list[Any] = []
            # raw_transcript is never overwritten by edits (contract).
            for col in ("text", "role", "eval_part", "conversation_key", "turn_index", "review_status"):
                if col in fields and fields[col] is not None:
                    sets.append(f"{col} = ?")
                    params.append(fields[col])
            if "text" in fields and fields["text"] is not None:
                sets.append("text_hash = ?")
                params.append(_sha256_text(fields["text"]))
            if "flags" in fields and fields["flags"] is not None:
                sets.append("flags_json = ?")
                params.append(json.dumps(fields["flags"]))
            sets.append("updated_at = ?")
            params.append(now)
            params.extend([dataset_id, line_id])
            conn.execute(
                f"UPDATE lines SET {', '.join(sets)} WHERE dataset_id = ? AND id = ?",
                params,
            )
            op = "set_review" if (set(fields.keys()) - {"base_revision_id"}) == {"review_status"} else "edit_line"
            revision_id = self._write_revision(conn, dataset_id, op, summary=f"Edited line {line_id}")
            card = self._card(conn, dataset_id)
            line_row = self._line_from_row(
                conn.execute(
                    "SELECT * FROM lines WHERE dataset_id = ? AND id = ?", (dataset_id, line_id)
                ).fetchone()
            )
            conn.execute("COMMIT")
            return {"dataset": card, "line": line_row, "revision_id": revision_id}
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- delete line (soft) -----------------------------------------------
    async def delete_line(
        self, dataset_id: str, line_id: str, *, base_revision_id: int | None
    ) -> dict[str, Any]:
        async with self._write_lock:
            return await run_in_threadpool(self._delete_line_sync, dataset_id, line_id, base_revision_id)

    def _delete_line_sync(
        self, dataset_id: str, line_id: str, base_revision_id: int | None
    ) -> dict[str, Any]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ds = self._get_dataset_row(conn, dataset_id)
            self._check_base_revision(conn, ds, base_revision_id)
            existing = conn.execute(
                "SELECT * FROM lines WHERE dataset_id = ? AND id = ? AND deleted_at IS NULL",
                (dataset_id, line_id),
            ).fetchone()
            if existing is None:
                raise NotFoundError(f"line {line_id} not found")
            now = _now()
            # soft delete: move it to a high, unique index out of the live 0..N range so the
            # remaining lines can renumber to contiguous 0-based values. CHECK(line_index >= 0)
            # forbids negatives, so use a large positive parking index unique per deleted row.
            deleted_count = conn.execute(
                "SELECT COUNT(*) AS c FROM lines WHERE dataset_id = ? AND deleted_at IS NOT NULL",
                (dataset_id,),
            ).fetchone()["c"]
            park_index = self._TEMP_OFFSET * 2 + int(deleted_count)
            conn.execute(
                "UPDATE lines SET deleted_at = ?, line_index = ?, updated_at = ? WHERE dataset_id = ? AND id = ?",
                (now, park_index, now, dataset_id, line_id),
            )
            self._renumber_contiguous(conn, dataset_id)
            revision_id = self._write_revision(conn, dataset_id, "delete_line", summary=f"Deleted line {line_id}")
            card = self._card(conn, dataset_id)
            conn.execute("COMMIT")
            return {"dataset": card, "revision_id": revision_id}
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- reorder ----------------------------------------------------------
    async def reorder(
        self, dataset_id: str, *, line_ids: list[str], base_revision_id: int | None
    ) -> dict[str, Any]:
        async with self._write_lock:
            return await run_in_threadpool(self._reorder_sync, dataset_id, line_ids, base_revision_id)

    def _reorder_sync(
        self, dataset_id: str, line_ids: list[str], base_revision_id: int | None
    ) -> dict[str, Any]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ds = self._get_dataset_row(conn, dataset_id)
            self._check_base_revision(conn, ds, base_revision_id)
            rows = conn.execute(
                "SELECT id FROM lines WHERE dataset_id = ? AND deleted_at IS NULL ORDER BY line_index",
                (dataset_id,),
            ).fetchall()
            current_ids = {r["id"] for r in rows}
            if set(line_ids) != current_ids or len(line_ids) != len(current_ids):
                raise OpenAIServiceError(
                    "reorder line_ids must be an exact permutation of current line ids.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            # phase 1: large positive temporary indices (CHECK forbids negatives)
            for i, lid in enumerate(line_ids):
                conn.execute(
                    "UPDATE lines SET line_index = ? WHERE dataset_id = ? AND id = ?",
                    (self._TEMP_OFFSET + i, dataset_id, lid),
                )
            # phase 2: final indices
            now = _now()
            for i, lid in enumerate(line_ids):
                conn.execute(
                    "UPDATE lines SET line_index = ?, updated_at = ? WHERE dataset_id = ? AND id = ?",
                    (i, now, dataset_id, lid),
                )
            revision_id = self._write_revision(conn, dataset_id, "reorder", summary="Reordered lines")
            card = self._card(conn, dataset_id)
            conn.execute("COMMIT")
            return {"dataset": card, "revision_id": revision_id}
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- rollback ---------------------------------------------------------
    async def rollback(self, dataset_id: str, *, target_revision_id: int) -> dict[str, Any]:
        async with self._write_lock:
            await run_in_threadpool(self._rollback_sync, dataset_id, target_revision_id)
        return await self.get_dataset_detail(dataset_id)

    def _rollback_sync(self, dataset_id: str, target_revision_id: int) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            self._get_dataset_row(conn, dataset_id)
            target = conn.execute(
                "SELECT * FROM revisions WHERE id = ? AND dataset_id = ?",
                (target_revision_id, dataset_id),
            ).fetchone()
            if target is None:
                raise NotFoundError(f"revision {target_revision_id} not found for dataset {dataset_id}")
            snap = conn.execute(
                "SELECT * FROM revision_lines WHERE revision_id = ? ORDER BY line_index",
                (target_revision_id,),
            ).fetchall()
            # wipe live lines, re-insert from snapshot
            conn.execute("DELETE FROM lines WHERE dataset_id = ?", (dataset_id,))
            now = _now()
            for r in snap:
                conn.execute(
                    "INSERT INTO lines (id, dataset_id, line_index, role, eval_part, conversation_key, turn_index, text, "
                    "raw_transcript, source, review_status, flags_json, metadata_json, text_hash, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        r["line_id"], dataset_id, r["line_index"], r["role"], r["eval_part"], r["conversation_key"],
                        r["turn_index"], r["text"], r["raw_transcript"], r["source"], r["review_status"],
                        r["flags_json"], r["metadata_json"], r["text_hash"], r["created_at"], now,
                    ),
                )
            self._write_revision(
                conn,
                dataset_id,
                "rollback",
                summary=f"Rolled back to revision {target_revision_id}",
                meta={"target_revision_id": target_revision_id},
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- capture (audio-first, idempotent) --------------------------------
    def store_audio(self, audio_bytes: bytes) -> tuple[str, str]:
        """Persist audio to {data_dir}/audio/<sha>.webm. Returns (sha, relative_path)."""
        self._ensure_dirs()
        sha = hashlib.sha256(audio_bytes).hexdigest()
        path = self.audio_dir / f"{sha}.webm"
        if not path.exists():
            path.write_bytes(audio_bytes)
        rel = str(path.relative_to(self.data_dir.parent)) if self.data_dir.parent in path.parents else str(path)
        return sha, str(Path(self.data_dir.name) / "audio" / f"{sha}.webm")

    async def get_capture_segment(self, client_segment_id: str) -> dict[str, Any] | None:
        def work() -> dict[str, Any] | None:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT * FROM capture_segments WHERE id = ?", (client_segment_id,)
                ).fetchone()
                return dict(row) if row else None
            finally:
                conn.close()

        return await run_in_threadpool(work)

    async def upsert_capture_segment(
        self,
        *,
        client_segment_id: str,
        dataset_id: str,
        audio_path: str | None,
        audio_sha256: str | None,
        duration_ms: int | None,
        status_value: str,
    ) -> None:
        async with self._write_lock:
            await run_in_threadpool(
                self._upsert_capture_segment_sync,
                client_segment_id,
                dataset_id,
                audio_path,
                audio_sha256,
                duration_ms,
                status_value,
            )

    def _upsert_capture_segment_sync(
        self,
        client_segment_id: str,
        dataset_id: str,
        audio_path: str | None,
        audio_sha256: str | None,
        duration_ms: int | None,
        status_value: str,
    ) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            now = _now()
            existing = conn.execute(
                "SELECT id FROM capture_segments WHERE id = ?", (client_segment_id,)
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO capture_segments (id, dataset_id, audio_path, audio_sha256, duration_ms, status, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (client_segment_id, dataset_id, audio_path, audio_sha256, duration_ms, status_value, now, now),
                )
            else:
                conn.execute(
                    "UPDATE capture_segments SET dataset_id = ?, audio_path = COALESCE(?, audio_path), "
                    "audio_sha256 = COALESCE(?, audio_sha256), duration_ms = COALESCE(?, duration_ms), "
                    "status = ?, updated_at = ? WHERE id = ?",
                    (dataset_id, audio_path, audio_sha256, duration_ms, status_value, now, client_segment_id),
                )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    async def mark_capture_failed(self, client_segment_id: str, error: str) -> None:
        async with self._write_lock:
            await run_in_threadpool(self._mark_capture_failed_sync, client_segment_id, error)

    def _mark_capture_failed_sync(self, client_segment_id: str, error: str) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "UPDATE capture_segments SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
                (error[:2000], _now(), client_segment_id),
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    async def append_for_capture(
        self,
        dataset_id: str,
        *,
        client_segment_id: str,
        text: str,
        role: str,
        eval_part: str,
        conversation_key: str | None,
        turn_index: int | None,
        raw_transcript: str | None,
        metadata: dict[str, Any],
        auto_roll: bool,
    ) -> dict[str, Any]:
        """Append a captured line and mark the segment appended in one transaction (idempotent)."""
        async with self._write_lock:
            return await run_in_threadpool(
                self._append_for_capture_sync,
                dataset_id,
                client_segment_id,
                text,
                role,
                eval_part,
                conversation_key,
                turn_index,
                raw_transcript,
                metadata,
                auto_roll,
            )

    def _build_append_result(self, conn: sqlite3.Connection, segment: sqlite3.Row) -> dict[str, Any]:
        line_id = segment["line_id"]
        line_row = conn.execute(
            "SELECT * FROM lines WHERE id = ?", (line_id,)
        ).fetchone()
        if line_row is None:
            raise NotFoundError("appended line missing")
        target_id = line_row["dataset_id"]
        card = self._card(conn, target_id)
        rev = card["current_revision_id"]
        return {
            "requested_dataset_id": segment["dataset_id"],
            "dataset_id": target_id,
            "rolled": target_id != segment["dataset_id"],
            "line": self._line_from_row(line_row),
            "dataset": card,
            "revision_id": rev,
        }

    def _append_for_capture_sync(
        self,
        dataset_id: str,
        client_segment_id: str,
        text: str,
        role: str,
        eval_part: str,
        conversation_key: str | None,
        turn_index: int | None,
        raw_transcript: str | None,
        metadata: dict[str, Any],
        auto_roll: bool,
    ) -> dict[str, Any]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            segment = conn.execute(
                "SELECT * FROM capture_segments WHERE id = ?", (client_segment_id,)
            ).fetchone()
            if segment is not None and segment["status"] == "appended" and segment["line_id"]:
                # Idempotent: already appended, return existing result.
                result = self._build_append_result(conn, segment)
                conn.execute("COMMIT")
                return result

            requested_dataset_id = dataset_id
            ds = self._get_dataset_row(conn, dataset_id)
            series = self._get_series_row(conn, ds["series_id"])
            rolled = False
            target_id = dataset_id
            if auto_roll and self._line_count(conn, dataset_id) >= series["page_size"]:
                target_id = self._roll_to_next_page(conn, ds, series)
                rolled = True

            line = self._insert_line(
                conn,
                target_id,
                text=text,
                role=role,
                eval_part=eval_part,
                conversation_key=conversation_key,
                turn_index=turn_index,
                raw_transcript=raw_transcript,
                source="voice",
                metadata=metadata,
                review_status="unreviewed",
                flags=None,
            )
            revision_id = self._write_revision(
                conn, target_id, "append", summary=f"Captured line {line['line_index']}"
            )
            now = _now()
            conn.execute(
                "UPDATE capture_segments SET status = 'appended', line_id = ?, dataset_id = ?, updated_at = ? WHERE id = ?",
                (line["id"], target_id, now, client_segment_id),
            )
            card = self._card(conn, target_id)
            line_row = self._line_from_row(
                conn.execute(
                    "SELECT * FROM lines WHERE dataset_id = ? AND id = ?", (target_id, line["id"])
                ).fetchone()
            )
            conn.execute("COMMIT")
            return {
                "requested_dataset_id": requested_dataset_id,
                "dataset_id": target_id,
                "rolled": rolled,
                "line": line_row,
                "dataset": card,
                "revision_id": revision_id,
            }
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- exports ----------------------------------------------------------
    async def export_txt(self, dataset_id: str, *, annotated: bool = False) -> str:
        detail = await self.get_dataset_detail(dataset_id)
        return self.build_txt(detail["lines"], annotated=annotated)

    @staticmethod
    def build_txt(lines: list[dict[str, Any]], *, annotated: bool = False) -> str:
        out: list[str] = []
        for ln in lines:
            if annotated:
                out.append(f"[{ln['role']}] {ln['text']}")
            else:
                out.append(ln["text"])
        return "\n".join(out) + ("\n" if out else "")

    async def export_jsonl(
        self, dataset_id: str, *, scope: str = "accepted"
    ) -> str:
        detail = await self.get_dataset_detail(dataset_id)
        return self.build_jsonl(
            detail["lines"],
            dataset_id=dataset_id,
            language=detail["language"],
            scope=scope,
        )

    @staticmethod
    def build_jsonl(
        lines: list[dict[str, Any]],
        *,
        dataset_id: str,
        language: str,
        scope: str = "accepted",
    ) -> str:
        if scope == "accepted":
            lines = [ln for ln in lines if ln["review_status"] == "accepted"]
        # scope == "all": keep all non-deleted lines (already non-deleted here)

        def stt_model_of(ln: dict[str, Any]) -> str | None:
            md = ln.get("metadata") or {}
            return md.get("stt_model")

        records: list[dict[str, Any]] = []

        # Group lines by conversation_key; null-keyed lines are each their own example.
        grouped: dict[str, list[dict[str, Any]]] = {}
        singles: list[dict[str, Any]] = []
        for ln in lines:
            key = ln.get("conversation_key")
            if key:
                grouped.setdefault(key, []).append(ln)
            else:
                singles.append(ln)

        # Conversation groups -> messages + optional expected.
        for key, group in grouped.items():
            group_sorted = sorted(
                group,
                key=lambda x: (x["turn_index"] if x["turn_index"] is not None else x["line_index"]),
            )
            messages: list[dict[str, str]] = []
            expected: dict[str, str] | None = None
            line_ids: list[str] = []
            stt_model: str | None = None
            for ln in group_sorted:
                line_ids.append(ln["id"])
                stt_model = stt_model or stt_model_of(ln)
                if ln["eval_part"] == "expected":
                    expected = {"role": ln["role"], "content": ln["text"]}
                else:
                    messages.append({"role": ln["role"], "content": ln["text"]})
            rec: dict[str, Any] = {
                "id": f"ex_{key}",
                "messages": messages,
            }
            if expected is not None:
                rec["expected"] = expected
            rec["metadata"] = {
                "dataset_id": dataset_id,
                "language": language,
                "stt_model": stt_model,
                "line_ids": line_ids,
            }
            records.append(rec)

        # Null-keyed singles: one example per line.
        for ln in singles:
            rec = {
                "id": f"ex_{ln['id']}",
                "messages": [{"role": ln["role"], "content": ln["text"]}],
                "metadata": {
                    "dataset_id": dataset_id,
                    "language": language,
                    "stt_model": stt_model_of(ln),
                    "line_ids": [ln["id"]],
                },
            }
            # eval_part == ignored & null key -> single message, no expected (contract).
            records.append(rec)

        return "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + ("\n" if records else "")
