from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status


@dataclass(slots=True)
class OpenAIServiceError(Exception):
    message: str
    status_code: int = status.HTTP_502_BAD_GATEWAY
    details: Any | None = None


def as_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, OpenAIServiceError):
        return HTTPException(status_code=exc.status_code, detail={"message": exc.message, "details": exc.details})
    return HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))
