from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import settings
from app.core.config import Settings
from app.domain.schemas import (
    Emotion,
    Gesture,
    HealthResponse,
    PublicConfig,
    SttPrompt,
    TranscribeTier,
)

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
async def health(cfg: Settings = Depends(settings)) -> HealthResponse:
    return HealthResponse(
        status="ok",
        openai_configured=cfg.openai_enabled,
        response_model=cfg.openai_response_model,
        tts_model=cfg.openai_tts_model,
        transcribe_model=cfg.openai_transcribe_model,
    )


@router.get("/config", response_model=PublicConfig)
async def public_config(cfg: Settings = Depends(settings)) -> PublicConfig:
    return PublicConfig(
        response_model=cfg.openai_response_model,
        tts_model=cfg.openai_tts_model,
        transcribe_model=cfg.openai_transcribe_model,
        default_voice=cfg.openai_tts_voice,
        voices=["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"],
        emotions=[e.value for e in Emotion],
        gestures=[g.value for g in Gesture],
        transcribe_tiers=[
            TranscribeTier(id="fast", label="Fast", model=cfg.openai_transcribe_model_fast),
            TranscribeTier(id="best", label="Best", model=cfg.openai_transcribe_model_best),
            TranscribeTier(id="whisper", label="Whisper", model=cfg.openai_transcribe_model_whisper),
        ],
        stt_prompts=[SttPrompt(id="bn-codeswitch-v1", label="Bengali code-switch v1")],
        languages=["bn", "auto", "en"],
        dataset_page_size_default=cfg.dataset_page_size_default,
    )
