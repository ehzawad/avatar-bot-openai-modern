from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse

from app.api.dependencies import dataset_store, openai_gateway, settings
from app.core.config import Settings
from app.core.errors import ConflictError, OpenAIServiceError, as_http_error
from app.domain.dataset_schemas import (
    AddLineRequest,
    AppendResult,
    CreateDatasetRequest,
    CreateDatasetResponse,
    DatasetDetail,
    DatasetListResponse,
    EditLineRequest,
    EditLineResponse,
    MutationResponse,
    RenameDatasetRequest,
    ReorderRequest,
    RevisionListResponse,
    RollbackRequest,
)
from app.services.dataset_store import DatasetStore, NotFoundError
from app.services.openai_gateway import OpenAIGateway

router = APIRouter(prefix="/datasets", tags=["datasets"])


# Bengali code-switch prompt, contract section 1, id "bn-codeswitch-v1".
STT_PROMPTS: dict[str, str] = {
    "bn-codeswitch-v1": (
        "এটি বাংলা কথোপকথনের সংক্ষিপ্ত utterance; মাঝে ইংরেজি tech/code-switch শব্দ থাকতে পারে। "
        "যা শোনা যায় শুধু সেটাই লিখুন; না শোনা গেলে খালি রাখুন। বাংলা শব্দ বাংলা লিপিতে লিখুন। "
        "ইংরেজি model, product, library, API, code identifier Latin script-এ রাখুন: OpenAI, ChatGPT, "
        "API, SQLite, React, Vite, FastAPI, TanStack Query, Zustand, JSON, WebM, Opus, eval, dataset, "
        "prompt. কথার filler রাখুন: উম, মানে, আচ্ছা।"
    ),
}

# tier -> response_format
TIER_RESPONSE_FORMAT: dict[str, str] = {
    "fast": "json",
    "best": "json",
    "diarize": "json",
}


def _tier_model(cfg: Settings, tier: str) -> str:
    return {
        "fast": cfg.openai_transcribe_model_fast,
        "best": cfg.openai_transcribe_model_best,
        "diarize": cfg.openai_transcribe_model_diarize,
    }.get(tier, cfg.openai_transcribe_model_best)


def _sanitize_filename(name: str) -> str:
    # Keep it ASCII-safe for the Content-Disposition filename token.
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return cleaned or "dataset"


def _handle(exc: Exception) -> None:
    raise as_http_error(exc) from exc


# ---------------------------------------------------------------------------
# Datasets / series
# ---------------------------------------------------------------------------
@router.get("", response_model=DatasetListResponse)
async def list_datasets(store: DatasetStore = Depends(dataset_store)) -> DatasetListResponse:
    cards = await store.list_datasets()
    return DatasetListResponse(datasets=cards)


@router.post("", response_model=CreateDatasetResponse, status_code=status.HTTP_201_CREATED)
async def create_dataset(
    body: CreateDatasetRequest,
    store: DatasetStore = Depends(dataset_store),
) -> CreateDatasetResponse:
    card = await store.create_series(title=body.title, page_size=body.page_size, language=body.language)
    return CreateDatasetResponse(dataset=card)


@router.get("/{dataset_id}", response_model=DatasetDetail)
async def get_dataset(dataset_id: str, store: DatasetStore = Depends(dataset_store)) -> DatasetDetail:
    try:
        detail = await store.get_dataset_detail(dataset_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    return DatasetDetail(**detail)


@router.patch("/{dataset_id}", response_model=CreateDatasetResponse)
async def rename_dataset(
    dataset_id: str,
    body: RenameDatasetRequest,
    store: DatasetStore = Depends(dataset_store),
) -> CreateDatasetResponse:
    try:
        card = await store.rename_dataset(dataset_id, name=body.name, base_revision_id=body.base_revision_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    except ConflictError as exc:
        raise as_http_error(exc) from exc
    return CreateDatasetResponse(dataset=card)


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(dataset_id: str, store: DatasetStore = Depends(dataset_store)) -> Response:
    try:
        await store.delete_dataset(dataset_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Capture (voice loop)
# ---------------------------------------------------------------------------
@router.post("/{dataset_id}/capture", response_model=AppendResult)
async def capture(
    dataset_id: str,
    audio: UploadFile = File(...),
    client_segment_id: str = Form(...),
    tier: Literal["fast", "best", "diarize"] = Form("best"),
    language: Literal["bn", "auto", "en"] = Form("bn"),
    prompt_id: str = Form("bn-codeswitch-v1"),
    auto_roll: bool = Form(True),
    role: Literal["user", "assistant", "interviewer", "system"] = Form("user"),
    eval_part: Literal["prompt", "context", "expected", "ignored"] = Form("ignored"),
    conversation_key: str | None = Form(None),
    turn_index: int | None = Form(None),
    tag: str | None = Form(None),
    duration_ms: int | None = Form(None),
    store: DatasetStore = Depends(dataset_store),
    openai: OpenAIGateway = Depends(openai_gateway),
    cfg: Settings = Depends(settings),
) -> AppendResult:
    # Idempotency short-circuit: if already appended, return existing result.
    existing = await store.get_capture_segment(client_segment_id)
    if existing and existing.get("status") == "appended" and existing.get("line_id"):
        result = await store.append_for_capture(
            existing.get("dataset_id", dataset_id),
            client_segment_id=client_segment_id,
            text="",
            role=role,
            eval_part=eval_part,
            conversation_key=conversation_key,
            turn_index=turn_index,
            raw_transcript=None,
            metadata={},
            auto_roll=auto_roll,
            tag=tag,
        )
        return AppendResult(**result)

    # Validate the target dataset BEFORE reading/persisting audio or transcribing, so a bad
    # or deleted dataset_id fails fast with 404 instead of wasting an OpenAI call + leaving
    # an orphan audio file and capture_segments row.
    try:
        await store.ensure_dataset(dataset_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise as_http_error(OpenAIServiceError("No audio was uploaded.", status.HTTP_400_BAD_REQUEST))

    # Audio-first durability: persist + upsert the segment as 'stored' before transcribing.
    try:
        sha, audio_rel_path = store.store_audio(audio_bytes)
    except Exception as exc:  # noqa: BLE001
        raise as_http_error(OpenAIServiceError(f"Failed to persist audio: {exc}", status.HTTP_500_INTERNAL_SERVER_ERROR)) from exc

    await store.upsert_capture_segment(
        client_segment_id=client_segment_id,
        dataset_id=dataset_id,
        audio_path=audio_rel_path,
        audio_sha256=sha,
        duration_ms=duration_ms,
        status_value="stored",
    )

    # Build transcription parameters.
    model = _tier_model(cfg, tier)
    response_format = TIER_RESPONSE_FORMAT.get(tier, "json")
    extra: dict[str, object] = {"temperature": "0"}
    # The diarization model has a restricted parameter surface: it rejects `prompt`
    # ("Prompt is not supported for diarization models") and the include[]/timestamp
    # extras. fast/best (gpt-4o(-mini)-transcribe) take the Bengali prompt + logprobs QC.
    if tier == "diarize":
        prompt: str | None = None
    else:
        prompt = STT_PROMPTS.get(prompt_id, STT_PROMPTS["bn-codeswitch-v1"])
        extra["include[]"] = ["logprobs"]

    try:
        result = await openai.transcribe(
            audio_bytes=audio_bytes,
            filename=audio.filename or "recording.webm",
            content_type=audio.content_type or "audio/webm",
            model=model,
            language=language,
            prompt=prompt,
            response_format=response_format,
            extra_fields=extra,  # type: ignore[arg-type]
        )
    except OpenAIServiceError as exc:
        # Transcription failed: keep audio, mark segment failed, return 502.
        await store.mark_capture_failed(client_segment_id, exc.message)
        from fastapi import HTTPException

        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"detail": exc.message, "client_segment_id": client_segment_id},
        ) from exc

    text = str(result.get("text", "")).strip()

    # mark transcribed
    await store.upsert_capture_segment(
        client_segment_id=client_segment_id,
        dataset_id=dataset_id,
        audio_path=audio_rel_path,
        audio_sha256=sha,
        duration_ms=duration_ms,
        status_value="transcribed",
    )

    logprobs = result.get("logprobs")
    logprob_avg = None
    if isinstance(logprobs, list) and logprobs:
        vals = [lp.get("logprob") for lp in logprobs if isinstance(lp, dict) and isinstance(lp.get("logprob"), (int, float))]
        if vals:
            logprob_avg = sum(vals) / len(vals)

    metadata = {
        "stt_model": model,
        "model_tier": tier,
        "language_requested": language,
        "stt_prompt_id": prompt_id,
        "audio_duration_ms": duration_ms,
        "audio_sha256": sha,
        "audio_path": audio_rel_path,
        "logprob_avg": logprob_avg,
    }

    try:
        append = await store.append_for_capture(
            dataset_id,
            client_segment_id=client_segment_id,
            text=text,
            role=role,
            eval_part=eval_part,
            conversation_key=conversation_key,
            turn_index=turn_index,
            raw_transcript=text,
            metadata=metadata,
            auto_roll=auto_roll,
            tag=tag,
        )
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    return AppendResult(**append)


# ---------------------------------------------------------------------------
# Lines (manual edits)
# ---------------------------------------------------------------------------
@router.post("/{dataset_id}/lines", response_model=AppendResult)
async def add_line(
    dataset_id: str,
    body: AddLineRequest,
    store: DatasetStore = Depends(dataset_store),
) -> AppendResult:
    try:
        result = await store.append(
            dataset_id,
            text=body.text,
            role=body.role.value,
            eval_part=body.eval_part.value,
            conversation_key=body.conversation_key,
            turn_index=body.turn_index,
            tag=body.tag,
            source="manual",
            base_revision_id=body.base_revision_id,
            auto_roll=True,
        )
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    except (ConflictError, OpenAIServiceError) as exc:
        raise as_http_error(exc) from exc
    return AppendResult(**result)


@router.patch("/{dataset_id}/lines/{line_id}", response_model=EditLineResponse)
async def edit_line(
    dataset_id: str,
    line_id: str,
    body: EditLineRequest,
    store: DatasetStore = Depends(dataset_store),
) -> EditLineResponse:
    fields = body.model_dump(exclude_unset=True, exclude={"base_revision_id"})
    # Convert enum members to their string values.
    for key in ("role", "eval_part", "review_status"):
        if key in fields and fields[key] is not None and hasattr(fields[key], "value"):
            fields[key] = fields[key].value
    try:
        result = await store.edit_line(
            dataset_id, line_id, fields=fields, base_revision_id=body.base_revision_id
        )
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    except (ConflictError, OpenAIServiceError) as exc:
        raise as_http_error(exc) from exc
    return EditLineResponse(**result)


@router.delete("/{dataset_id}/lines/{line_id}", response_model=MutationResponse)
async def delete_line(
    dataset_id: str,
    line_id: str,
    base_revision_id: int | None = Query(None),
    store: DatasetStore = Depends(dataset_store),
) -> MutationResponse:
    try:
        result = await store.delete_line(dataset_id, line_id, base_revision_id=base_revision_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    except (ConflictError, OpenAIServiceError) as exc:
        raise as_http_error(exc) from exc
    return MutationResponse(**result)


@router.patch("/{dataset_id}/reorder", response_model=MutationResponse)
async def reorder_lines(
    dataset_id: str,
    body: ReorderRequest,
    store: DatasetStore = Depends(dataset_store),
) -> MutationResponse:
    try:
        result = await store.reorder(
            dataset_id, line_ids=body.line_ids, base_revision_id=body.base_revision_id
        )
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    except (ConflictError, OpenAIServiceError) as exc:
        raise as_http_error(exc) from exc
    return MutationResponse(**result)


# ---------------------------------------------------------------------------
# Revisions / rollback
# ---------------------------------------------------------------------------
@router.get("/{dataset_id}/revisions", response_model=RevisionListResponse)
async def list_revisions(dataset_id: str, store: DatasetStore = Depends(dataset_store)) -> RevisionListResponse:
    try:
        revisions = await store.list_revisions(dataset_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    return RevisionListResponse(revisions=revisions)


@router.post("/{dataset_id}/rollback", response_model=DatasetDetail)
async def rollback(
    dataset_id: str,
    body: RollbackRequest,
    store: DatasetStore = Depends(dataset_store),
) -> DatasetDetail:
    try:
        detail = await store.rollback(dataset_id, target_revision_id=body.target_revision_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc
    return DatasetDetail(**detail)


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------
@router.get("/{dataset_id}/download")
async def download(
    dataset_id: str,
    format: Literal["txt", "jsonl", "csv"] = Query("txt"),
    annotated: bool = Query(False),
    scope: Literal["accepted", "all"] | None = Query(None),
    store: DatasetStore = Depends(dataset_store),
) -> StreamingResponse:
    try:
        card = await store.get_card(dataset_id)
    except NotFoundError as exc:
        raise as_http_error(OpenAIServiceError(str(exc), status.HTTP_404_NOT_FOUND)) from exc

    base = _sanitize_filename(card["name"])
    if format == "txt":
        content = await store.export_txt(dataset_id, annotated=annotated)
        media_type = "text/plain; charset=utf-8"
        filename = f"{base}.txt"
    elif format == "csv":
        # CSV default scope is 'all' (contract section 6); 'accepted' is opt-in.
        csv_scope = scope or "all"
        content = await store.export_csv(dataset_id, scope=csv_scope)
        media_type = "text/csv; charset=utf-8"
        filename = f"{base}.csv"
    else:
        # jsonl default scope is 'accepted' (contract section 3).
        content = await store.export_jsonl(dataset_id, scope=scope or "accepted")
        media_type = "application/x-ndjson"
        filename = f"{base}.jsonl"

    async def gen():
        yield content.encode("utf-8")

    return StreamingResponse(
        gen(),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
