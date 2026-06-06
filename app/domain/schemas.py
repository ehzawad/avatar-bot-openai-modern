from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator


class Emotion(StrEnum):
    neutral = "neutral"
    joy = "joy"
    sorrow = "sorrow"
    angry = "angry"
    fun = "fun"
    surprised = "surprised"


class Gesture(StrEnum):
    idle = "idle"
    nod = "nod"
    shake = "shake"
    lean_in = "lean_in"
    wave = "wave"


class InteractionMode(StrEnum):
    chat = "chat"
    live_interview = "live_interview"


class AudioPayload(BaseModel):
    mime_type: str
    format: str
    data_url: str


class AvatarReply(BaseModel):
    text: str = Field(min_length=1)
    emotion: Emotion = Emotion.neutral
    gesture: Gesture = Gesture.idle
    listen_hint: str = ""


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    voice: str | None = None
    interaction_mode: InteractionMode

    @field_validator("message")
    @classmethod
    def clean_message(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Message cannot be empty.")
        return cleaned


class ChatResponse(BaseModel):
    conversation_id: str
    message_id: str
    response_id: str | None
    reply: AvatarReply
    audio: AudioPayload
    usage: dict[str, Any] | None = None


class CreateConversationResponse(BaseModel):
    conversation_id: str
    created_at: datetime


class ConversationSummary(BaseModel):
    conversation_id: str
    created_at: datetime
    updated_at: datetime
    turns: int
    last_response_id: str | None = None


class HealthResponse(BaseModel):
    status: str
    openai_configured: bool
    response_model: str
    tts_model: str
    transcribe_model: str


class PublicConfig(BaseModel):
    response_model: str
    tts_model: str
    transcribe_model: str
    default_voice: str
    voices: list[str]
    emotions: list[str]
    gestures: list[str]


class TranscriptionResponse(BaseModel):
    text: str


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
