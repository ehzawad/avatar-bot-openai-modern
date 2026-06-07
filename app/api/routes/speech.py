from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile

from app.api.dependencies import openai_gateway
from app.core.errors import OpenAIServiceError, as_http_error
from app.domain.schemas import TranscriptionResponse
from app.services.openai_gateway import OpenAIGateway

router = APIRouter(prefix="/speech", tags=["speech"])


@router.post("/transcriptions", response_model=TranscriptionResponse)
async def transcribe_audio(
    audio: UploadFile = File(...),
    openai: OpenAIGateway = Depends(openai_gateway),
) -> TranscriptionResponse:
    try:
        data = await audio.read()
        result = await openai.transcribe(audio_bytes=data, filename=audio.filename or "recording.webm", content_type=audio.content_type)
        return TranscriptionResponse(text=str(result.get("text", "")).strip())
    except OpenAIServiceError as exc:
        raise as_http_error(exc) from exc
