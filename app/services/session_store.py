from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from threading import RLock
from typing import Any

from app.domain.schemas import ConversationSummary, new_id, utc_now


@dataclass(slots=True)
class Turn:
    user_text: str
    assistant_text: str
    emotion: str
    response_id: str | None
    created_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class ConversationState:
    conversation_id: str
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)
    last_response_id: str | None = None
    turns: list[Turn] = field(default_factory=list)

    def touch(self) -> None:
        self.updated_at = utc_now()


class InMemorySessionStore:
    """Small local session store.

    For production, replace this class with Redis/Postgres without touching route handlers.
    The Responses API response id is stored per conversation so follow-up turns can use
    previous_response_id instead of resending the whole transcript.
    """

    def __init__(self, ttl_seconds: int) -> None:
        self.ttl = timedelta(seconds=ttl_seconds)
        self._items: dict[str, ConversationState] = {}
        self._lock = RLock()

    def create(self) -> ConversationState:
        with self._lock:
            self._gc_locked()
            state = ConversationState(conversation_id=new_id("conv"))
            self._items[state.conversation_id] = state
            return state

    def get(self, conversation_id: str) -> ConversationState | None:
        with self._lock:
            self._gc_locked()
            state = self._items.get(conversation_id)
            if state:
                state.touch()
            return state

    def get_or_create(self, conversation_id: str | None = None) -> ConversationState:
        if conversation_id:
            existing = self.get(conversation_id)
            if existing:
                return existing
        return self.create()

    def append_turn(self, conversation_id: str, turn: Turn) -> ConversationState:
        with self._lock:
            state = self._items[conversation_id]
            state.turns.append(turn)
            state.last_response_id = turn.response_id
            state.touch()
            return state

    def summarize(self, state: ConversationState) -> ConversationSummary:
        return ConversationSummary(
            conversation_id=state.conversation_id,
            created_at=state.created_at,
            updated_at=state.updated_at,
            turns=len(state.turns),
            last_response_id=state.last_response_id,
        )

    def delete(self, conversation_id: str) -> bool:
        with self._lock:
            return self._items.pop(conversation_id, None) is not None

    def _gc_locked(self) -> None:
        cutoff = datetime.now(timezone.utc) - self.ttl
        expired = [cid for cid, state in self._items.items() if state.updated_at < cutoff]
        for cid in expired:
            self._items.pop(cid, None)
