from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import conversations, datasets, health, speech

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(conversations.router)
api_router.include_router(speech.router)
api_router.include_router(datasets.router)
