from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.router import api_router
from app.core.config import get_settings
from app.services.dataset_store import DatasetStore
from app.services.openai_gateway import OpenAIGateway
from app.services.orchestrator import AvatarConversationService
from app.services.session_store import InMemorySessionStore

ROOT = Path(__file__).resolve().parents[1]
WEB_DIST = ROOT / "web" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    cfg = get_settings()
    openai = OpenAIGateway(cfg)
    sessions = InMemorySessionStore(ttl_seconds=cfg.session_ttl_seconds)
    data_dir = Path(cfg.data_dir)
    if not data_dir.is_absolute():
        data_dir = ROOT / data_dir
    dataset_store = DatasetStore(data_dir=data_dir, page_size_default=cfg.dataset_page_size_default)
    await dataset_store.initialize()
    app.state.settings = cfg
    app.state.openai_gateway = openai
    app.state.session_store = sessions
    app.state.dataset_store = dataset_store
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
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )

    app.include_router(api_router)

    # Single unified SPA (web/dist) — serve hashed assets, then a guarded catch-all
    # that returns index.html for client routes. Guarded on WEB_DIST existence so the
    # app still imports/runs before the frontend is built. data/ is never web-served.
    if WEB_DIST.exists():
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa_fallback(path: str) -> FileResponse:
            candidate = (WEB_DIST / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(WEB_DIST):
                return FileResponse(candidate)
            if path.startswith("api/") or "." in Path(path).name:
                raise HTTPException(status_code=404)
            return FileResponse(
                WEB_DIST / "index.html",
                headers={"Cache-Control": "no-cache"},
            )

    return app


app = create_app()
