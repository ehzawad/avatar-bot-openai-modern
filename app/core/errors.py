from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status


@dataclass(slots=True)
class OpenAIServiceError(Exception):
    message: str
    status_code: int = status.HTTP_502_BAD_GATEWAY
    details: Any | None = None


@dataclass(slots=True)
class ConflictError(Exception):
    """Raised when a mutation's base_revision_id is stale vs the dataset's current revision."""

    message: str = "The dataset changed since you last loaded it. Reload and retry."
    current_revision_id: int | None = None


def as_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, OpenAIServiceError):
        return HTTPException(status_code=exc.status_code, detail={"message": exc.message, "details": exc.details})
    if isinstance(exc, ConflictError):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": exc.message,
                "code": "revision_conflict",
                "current_revision_id": exc.current_revision_id,
            },
        )
    return HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))
