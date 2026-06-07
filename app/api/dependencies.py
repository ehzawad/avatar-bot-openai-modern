from __future__ import annotations

from fastapi import Request

from app.core.config import Settings
from app.services.dataset_store import DatasetStore
from app.services.openai_gateway import OpenAIGateway
from app.services.orchestrator import AvatarConversationService
from app.services.session_store import InMemorySessionStore


def settings(request: Request) -> Settings:
    return request.app.state.settings


def openai_gateway(request: Request) -> OpenAIGateway:
    return request.app.state.openai_gateway


def session_store(request: Request) -> InMemorySessionStore:
    return request.app.state.session_store


def avatar_service(request: Request) -> AvatarConversationService:
    return request.app.state.avatar_service


def dataset_store(request: Request) -> DatasetStore:
    return request.app.state.dataset_store
