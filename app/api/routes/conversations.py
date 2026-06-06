from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import avatar_service, session_store
from app.core.errors import OpenAIServiceError, as_http_error
from app.domain.schemas import ChatRequest, ChatResponse, ConversationSummary, CreateConversationResponse
from app.services.orchestrator import AvatarConversationService
from app.services.session_store import InMemorySessionStore

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.post("", response_model=CreateConversationResponse, status_code=status.HTTP_201_CREATED)
async def create_conversation(service: AvatarConversationService = Depends(avatar_service)) -> CreateConversationResponse:
    state = await service.create_conversation()
    return CreateConversationResponse(conversation_id=state.conversation_id, created_at=state.created_at)


@router.get("/{conversation_id}", response_model=ConversationSummary)
async def get_conversation(conversation_id: str, sessions: InMemorySessionStore = Depends(session_store)) -> ConversationSummary:
    state = sessions.get(conversation_id)
    if not state:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    return sessions.summarize(state)


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: str, sessions: InMemorySessionStore = Depends(session_store)) -> None:
    sessions.delete(conversation_id)


@router.post("/{conversation_id}/messages", response_model=ChatResponse)
async def send_message(
    conversation_id: str,
    request: ChatRequest,
    service: AvatarConversationService = Depends(avatar_service),
) -> ChatResponse:
    try:
        return await service.send_message(
            conversation_id=conversation_id,
            message=request.message,
            voice=request.voice,
            interaction_mode=request.interaction_mode,
        )
    except OpenAIServiceError as exc:
        raise as_http_error(exc) from exc
