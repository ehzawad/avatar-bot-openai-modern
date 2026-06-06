from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.router import api_router
from app.core.config import get_settings
from app.services.openai_gateway import OpenAIGateway
from app.services.orchestrator import AvatarConversationService
from app.services.session_store import InMemorySessionStore

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    cfg = get_settings()
    openai = OpenAIGateway(cfg)
    sessions = InMemorySessionStore(ttl_seconds=cfg.session_ttl_seconds)
    app.state.settings = cfg
    app.state.openai_gateway = openai
    app.state.session_store = sessions
    app.state.avatar_service = AvatarConversationService(settings=cfg, openai=openai, sessions=sessions)
    try:
        yield
    finally:
        await openai.close()


def create_app() -> FastAPI:
    cfg = get_settings()
    app = FastAPI(title=cfg.app_name, lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
    )

    app.include_router(api_router)

    if FRONTEND_DIR.exists():
        app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    return app


app = create_app()
