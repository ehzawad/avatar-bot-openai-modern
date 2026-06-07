from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class Tier(StrEnum):
    fast = "fast"
    best = "best"


class Role(StrEnum):
    user = "user"
    assistant = "assistant"
    interviewer = "interviewer"
    system = "system"


class EvalPart(StrEnum):
    prompt = "prompt"
    context = "context"
    expected = "expected"
    ignored = "ignored"


class ReviewStatus(StrEnum):
    unreviewed = "unreviewed"
    accepted = "accepted"
    rejected = "rejected"
    needs_review = "needs_review"


class DatasetStatus(StrEnum):
    active = "active"
    full = "full"
    archived = "archived"


# ---------------------------------------------------------------------------
# Response models (mirror contract section 4)
# ---------------------------------------------------------------------------
class DatasetCard(BaseModel):
    id: str
    series_id: str
    page_no: int
    name: str
    status: DatasetStatus
    line_count: int
    page_size: int
    current_revision_id: int | None = None
    language: str
    created_at: str
    updated_at: str


class Line(BaseModel):
    id: str
    dataset_id: str
    line_index: int
    role: Role
    eval_part: EvalPart
    conversation_key: str | None = None
    turn_index: int | None = None
    text: str
    tag: str | None = None
    raw_transcript: str | None = None
    source: str
    review_status: ReviewStatus
    flags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class DatasetDetail(DatasetCard):
    lines: list[Line] = Field(default_factory=list)
    revision_count: int = 0


class Revision(BaseModel):
    id: int
    revision_no: int
    op: str
    summary: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)
    created_at: str


class AppendResult(BaseModel):
    requested_dataset_id: str
    dataset_id: str
    rolled: bool
    line: Line
    dataset: DatasetCard
    revision_id: int


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------
class CreateDatasetRequest(BaseModel):
    title: str | None = None
    page_size: int | None = Field(default=None, gt=0)
    language: str | None = None


class RenameDatasetRequest(BaseModel):
    name: str | None = None
    base_revision_id: int | None = None


class AddLineRequest(BaseModel):
    text: str
    role: Role = Role.user
    eval_part: EvalPart = EvalPart.ignored
    conversation_key: str | None = None
    turn_index: int | None = None
    tag: str | None = None
    base_revision_id: int | None = None


class EditLineRequest(BaseModel):
    text: str | None = None
    role: Role | None = None
    eval_part: EvalPart | None = None
    conversation_key: str | None = None
    turn_index: int | None = None
    tag: str | None = None
    review_status: ReviewStatus | None = None
    flags: list[str] | None = None
    base_revision_id: int | None = None


class ReorderRequest(BaseModel):
    line_ids: list[str]
    base_revision_id: int | None = None


class RollbackRequest(BaseModel):
    target_revision_id: int


# ---------------------------------------------------------------------------
# Generic mutation responses
# ---------------------------------------------------------------------------
class DatasetListResponse(BaseModel):
    datasets: list[DatasetCard]


class CreateDatasetResponse(BaseModel):
    dataset: DatasetCard


class EditLineResponse(BaseModel):
    dataset: DatasetCard
    line: Line
    revision_id: int


class MutationResponse(BaseModel):
    dataset: DatasetCard
    revision_id: int


class RevisionListResponse(BaseModel):
    revisions: list[Revision]
