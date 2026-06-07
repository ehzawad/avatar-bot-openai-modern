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

    # 9. Auto-roll: stale/full requested pages land on the series landing page.
    roll_card = await store.create_series(title="Roll series", page_size=2, language="bn")
    roll_p1 = roll_card["id"]
    await store.append(roll_p1, text="r1", role="user", eval_part="ignored", source="manual")
    await store.append(roll_p1, text="r2", role="user", eval_part="ignored", source="manual")
    rolled_once = await store.append(roll_p1, text="r3", role="user", eval_part="ignored", source="manual")
    roll_p2 = rolled_once["dataset_id"]
    check(rolled_once["rolled"] and roll_p2 != roll_p1, "auto-roll creates page 2 from a full latest page")
    check(rolled_once["dataset"]["page_no"] == 2, "first roll lands on page_no=2")
    rolled_existing = await store.append(roll_p1, text="r4", role="user", eval_part="ignored", source="manual")
    check(rolled_existing["dataset_id"] == roll_p2, "stale full page rolls to existing latest page with capacity")
    roll_p2_detail = await store.get_dataset_detail(roll_p2)
    check([ln["text"] for ln in roll_p2_detail["lines"]] == ["r3", "r4"], "existing landing page received second stale-page append")
    roll_p2_revs = await store.list_revisions(roll_p2)
    check(sum(1 for r in roll_p2_revs if r["op"] == "create") == 1, "rolling to existing page does not write another create revision")

    full_card = await store.create_series(title="Full roll series", page_size=1, language="bn")
    full_p1 = full_card["id"]
    await store.append(full_p1, text="f1", role="user", eval_part="ignored", source="manual")
    full_p2 = await store.append(full_p1, text="f2", role="user", eval_part="ignored", source="manual")
    full_p3 = await store.append(full_p1, text="f3", role="user", eval_part="ignored", source="manual")
    check(full_p2["dataset"]["page_no"] == 2, "page_size=1 first roll creates page 2")
    check(full_p3["dataset"]["page_no"] == 3, "all-pages-full stale append creates the next page")

    gap_card = await store.create_series(title="Gap roll series", page_size=1, language="bn")
    gap_p1 = gap_card["id"]
    await store.append(gap_p1, text="g1", role="user", eval_part="ignored", source="manual")
    gap_p2 = await store.append(gap_p1, text="g2", role="user", eval_part="ignored", source="manual")
    await store.delete_dataset(gap_p2["dataset_id"])
    gap_p3 = await store.append(gap_p1, text="g3", role="user", eval_part="ignored", source="manual")
    check(gap_p3["dataset"]["page_no"] == 3, "auto-roll allocates after soft-deleted page_no")

    # 10. Capture segment idempotency stays terminal once appended.
    cap_card = await store.create_series(title="Capture idempotency", page_size=50, language="bn")
    cap_ds = cap_card["id"]
    seg_id = "seg_smoke_idempotent"
    await store.upsert_capture_segment(
        client_segment_id=seg_id,
        dataset_id=cap_ds,
        audio_path="data/audio/one.webm",
        audio_sha256="sha-one",
        duration_ms=1000,
        status_value="stored",
    )
    cap_first = await store.append_for_capture(
        cap_ds,
        client_segment_id=seg_id,
        text="capture one",
        role="user",
        eval_part="ignored",
        conversation_key=None,
        turn_index=None,
        raw_transcript="capture one",
        metadata={},
        auto_roll=True,
    )
    await store.upsert_capture_segment(
        client_segment_id=seg_id,
        dataset_id=cap_ds,
        audio_path="data/audio/two.webm",
        audio_sha256="sha-two",
        duration_ms=2000,
        status_value="transcribed",
    )
    seg_after = await store.get_capture_segment(seg_id)
    check(seg_after is not None and seg_after["status"] == "appended", "capture upsert cannot downgrade appended segment")
    check(seg_after["line_id"] == cap_first["line"]["id"], "capture upsert preserves appended line id")
    cap_retry = await store.append_for_capture(
        cap_ds,
        client_segment_id=seg_id,
        text="capture duplicate",
        role="user",
        eval_part="ignored",
        conversation_key=None,
        turn_index=None,
        raw_transcript="capture duplicate",
        metadata={},
        auto_roll=True,
    )
    cap_detail = await store.get_dataset_detail(cap_ds)
    check(cap_retry["line"]["id"] == cap_first["line"]["id"], "capture retry returns original line")
    check([ln["text"] for ln in cap_detail["lines"]] == ["capture one"], "capture retry does not duplicate append")

    cap_roll_card = await store.create_series(title="Capture roll idempotency", page_size=1, language="bn")
    cap_roll_p1 = cap_roll_card["id"]
    await store.upsert_capture_segment(
        client_segment_id="seg_smoke_roll_first",
        dataset_id=cap_roll_p1,
        audio_path="data/audio/roll-one.webm",
        audio_sha256="sha-roll-one",
        duration_ms=1000,
        status_value="stored",
    )
    await store.append_for_capture(
        cap_roll_p1,
        client_segment_id="seg_smoke_roll_first",
        text="roll capture one",
        role="user",
        eval_part="ignored",
        conversation_key=None,
        turn_index=None,
        raw_transcript="roll capture one",
        metadata={},
        auto_roll=True,
    )
    await store.upsert_capture_segment(
        client_segment_id="seg_smoke_roll_second",
        dataset_id=cap_roll_p1,
        audio_path="data/audio/roll-two.webm",
        audio_sha256="sha-roll-two",
        duration_ms=1000,
        status_value="stored",
    )
    cap_roll_append = await store.append_for_capture(
        cap_roll_p1,
        client_segment_id="seg_smoke_roll_second",
        text="roll capture two",
        role="user",
        eval_part="ignored",
        conversation_key=None,
        turn_index=None,
        raw_transcript="roll capture two",
        metadata={},
        auto_roll=True,
    )
    cap_roll_retry = await store.append_for_capture(
        cap_roll_p1,
        client_segment_id="seg_smoke_roll_second",
        text="roll capture duplicate",
        role="user",
        eval_part="ignored",
        conversation_key=None,
        turn_index=None,
        raw_transcript="roll capture duplicate",
        metadata={},
        auto_roll=True,
    )
    check(cap_roll_append["requested_dataset_id"] == cap_roll_p1, "rolled capture records original requested page")
    check(cap_roll_append["rolled"] and cap_roll_append["dataset_id"] != cap_roll_p1, "rolled capture reports actual target page")
    check(cap_roll_retry["requested_dataset_id"] == cap_roll_append["requested_dataset_id"], "rolled capture retry preserves requested page")
    check(cap_roll_retry["dataset_id"] == cap_roll_append["dataset_id"], "rolled capture retry preserves actual target page")
    check(cap_roll_retry["rolled"] == cap_roll_append["rolled"], "rolled capture retry preserves rolled flag")

    # 11. Per-line TAG + CSV export (contract section 6).
    tag_card = await store.create_series(title="Tag series", page_size=50, language="bn")
    tag_ds = tag_card["id"]
    # A line whose tag is set and whose text has a comma AND a double-quote.
    tricky_text = 'আমি ভালো আছি, "সত্যিই"।'
    r_tag = await store.append(tag_ds, text=tricky_text, role="user", source="manual", tag="greeting")
    tagged_line_id = r_tag["line"]["id"]
    check(r_tag["line"]["tag"] == "greeting", "tag stored on capture/append")
    # A null-tag line (whitespace-only tag normalizes to NULL).
    r_null = await store.append(tag_ds, text="দ্বিতীয় লাইন", role="user", source="manual", tag="   ")
    check(r_null["line"]["tag"] is None, "whitespace-only tag stored as NULL")

    # CSV builder: RFC-4180 quoting.
    detail = await store.get_dataset_detail(tag_ds)
    csv_out = store.build_csv(detail["lines"], scope="all")
    csv_lines = csv_out.split("\r\n")
    check(csv_lines[0] == '"text","tagname"', "csv header is quoted text,tagname")
    # comma + embedded double-quote round-trips: quotes doubled, whole field wrapped.
    expected_tricky = '"আমি ভালো আছি, ""সত্যিই""।","greeting"'
    check(csv_lines[1] == expected_tricky, "comma+quote text RFC-4180 quoted with tag")
    check(csv_lines[2] == '"দ্বিতীয় লাইন",""', "null-tag line emits empty quoted field")
    # Round-trip back through the csv module to confirm correctness.
    import csv as _csv
    import io as _io

    parsed = list(_csv.reader(_io.StringIO(csv_out)))
    check(parsed[0] == ["text", "tagname"], "csv parses back to header row")
    check(parsed[1] == [tricky_text, "greeting"], "csv round-trips tricky text + tag")
    check(parsed[2] == ["দ্বিতীয় লাইন", ""], "csv round-trips null tag as empty string")

    # export_csv via the async store path.
    csv_async = await store.export_csv(tag_ds, scope="all")
    check(csv_async == csv_out, "export_csv matches build_csv output")

    # 12. Tag survives an edit and a rollback.
    detail_before_edit = await store.get_dataset_detail(tag_ds)
    rev_with_tags = detail_before_edit["current_revision_id"]
    await store.edit_line(tag_ds, tagged_line_id, fields={"tag": "salutation"}, base_revision_id=None)
    detail = await store.get_dataset_detail(tag_ds)
    edited = next(ln for ln in detail["lines"] if ln["id"] == tagged_line_id)
    check(edited["tag"] == "salutation", "tag survives an edit (new value applied)")
    # Clearing a tag via empty string -> NULL.
    await store.edit_line(tag_ds, tagged_line_id, fields={"tag": "  "}, base_revision_id=None)
    detail = await store.get_dataset_detail(tag_ds)
    cleared = next(ln for ln in detail["lines"] if ln["id"] == tagged_line_id)
    check(cleared["tag"] is None, "tag cleared to NULL via whitespace edit")
    # Rollback to the snapshot taken when tag was 'greeting'.
    await store.rollback(tag_ds, target_revision_id=rev_with_tags)
    detail = await store.get_dataset_detail(tag_ds)
    rolled = next(ln for ln in detail["lines"] if ln["id"] == tagged_line_id)
    check(rolled["tag"] == "greeting", "tag survives a rollback (restored from snapshot)")


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
