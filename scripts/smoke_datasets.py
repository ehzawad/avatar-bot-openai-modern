#!/usr/bin/env python3
"""Standalone, no-network smoke test for the dataset store.

Exercises: create series+page, append several lines (bypassing OpenAI), edit, reorder,
soft-delete (assert contiguous 0-based line_index among non-deleted), rollback to an earlier
revision (assert state restored), and build both txt and jsonl exports.

Run: python3 scripts/smoke_datasets.py   (exits 0 on success)
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

# Make the project root importable when run directly.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.dataset_store import DatasetStore  # noqa: E402


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    print(f"  PASS: {msg}")


async def run() -> None:
    tmp = tempfile.mkdtemp(prefix="studio_smoke_")
    store = DatasetStore(data_dir=tmp, page_size_default=50)
    await store.initialize()
    print(f"[setup] data_dir={tmp}")

    # 1. Create series + first page.
    card = await store.create_series(title="Smoke series", page_size=50, language="bn")
    ds_id = card["id"]
    check(card["page_no"] == 1, "first page is page_no=1")
    check(card["line_count"] == 0, "new page has 0 lines")
    check(card["current_revision_id"] is not None, "create wrote a revision")

    # 2. Append several lines directly (bypassing OpenAI).
    texts = ["আমি ভালো আছি", "তুমি কেমন আছো", "API টা কাজ করছে না", "চল eval চালাই"]
    line_ids: list[str] = []
    for t in texts:
        r = await store.append(ds_id, text=t, role="user", eval_part="ignored", source="manual")
        line_ids.append(r["line"]["id"])
    detail = await store.get_dataset_detail(ds_id)
    check(len(detail["lines"]) == 4, "4 lines appended")
    check([ln["line_index"] for ln in detail["lines"]] == [0, 1, 2, 3], "indices contiguous after append")
    rev_after_append = detail["current_revision_id"]

    # 3. Edit a line (text changes, raw_transcript untouched).
    edit = await store.edit_line(ds_id, line_ids[1], fields={"text": "তুমি কেমন আছো ভাই"}, base_revision_id=None)
    check(edit["line"]["text"] == "তুমি কেমন আছো ভাই", "edit applied new text")

    # 4. Reorder (reverse).
    reordered = list(reversed(line_ids))
    await store.reorder(ds_id, line_ids=reordered, base_revision_id=None)
    detail = await store.get_dataset_detail(ds_id)
    order = [ln["id"] for ln in detail["lines"]]
    check(order == reordered, "reorder produced the requested order")
    check([ln["line_index"] for ln in detail["lines"]] == [0, 1, 2, 3], "indices contiguous after reorder")

    # 5. Soft-delete the first line in current order; assert contiguous 0-based among non-deleted.
    to_delete = order[0]
    await store.delete_line(ds_id, to_delete, base_revision_id=None)
    detail = await store.get_dataset_detail(ds_id)
    remaining = [ln["id"] for ln in detail["lines"]]
    check(to_delete not in remaining, "deleted line gone from live view")
    check(len(remaining) == 3, "3 lines remain")
    check([ln["line_index"] for ln in detail["lines"]] == [0, 1, 2], "indices contiguous 0-based after delete")

    # 6. Rollback to the revision right after appends (before edit/reorder/delete).
    await store.rollback(ds_id, target_revision_id=rev_after_append)
    detail = await store.get_dataset_detail(ds_id)
    restored_ids = [ln["id"] for ln in detail["lines"]]
    restored_text = [ln["text"] for ln in detail["lines"]]
    check(restored_ids == line_ids, "rollback restored original line order")
    check(restored_text == texts, "rollback restored original text (edit undone)")
    check([ln["line_index"] for ln in detail["lines"]] == [0, 1, 2, 3], "indices contiguous after rollback")

    # 7. Exports.
    txt = await store.export_txt(ds_id, annotated=False)
    check(txt.strip().splitlines() == texts, "txt export matches lines in order")
    annotated = await store.export_txt(ds_id, annotated=True)
    check(annotated.startswith("[user] "), "annotated txt prefixes role")

    # jsonl: mark one line accepted, default scope=accepted exports only that one.
    await store.edit_line(ds_id, line_ids[0], fields={"review_status": "accepted"}, base_revision_id=None)
    jsonl_accepted = await store.export_jsonl(ds_id, scope="accepted")
    accepted_records = [json.loads(x) for x in jsonl_accepted.strip().splitlines()]
    check(len(accepted_records) == 1, "scope=accepted exports only accepted line")
    check(accepted_records[0]["messages"][0]["content"] == texts[0], "accepted record content correct")
    check("expected" not in accepted_records[0], "ignored+null-key line has no expected")

    jsonl_all = await store.export_jsonl(ds_id, scope="all")
    all_records = [json.loads(x) for x in jsonl_all.strip().splitlines()]
    check(len(all_records) == 4, "scope=all exports every non-deleted line")
    check(all_records[0]["metadata"]["dataset_id"] == ds_id, "jsonl metadata carries dataset_id")
    check(all_records[0]["metadata"]["language"] == "bn", "jsonl metadata carries language")

    # 8. Revisions accumulated and are newest-first.
    revs = await store.list_revisions(ds_id)
    ops = [r["op"] for r in revs]
    check("rollback" in ops, "rollback revision recorded")
    check(revs[0]["revision_no"] > revs[-1]["revision_no"], "revisions listed newest-first")


def main() -> int:
    try:
        asyncio.run(run())
    except Exception as exc:  # noqa: BLE001
        print(f"\nFAIL: {exc}")
        import traceback

        traceback.print_exc()
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
