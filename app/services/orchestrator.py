from __future__ import annotations

from app.core.config import Settings
from app.domain.schemas import AudioPayload, ChatResponse, InteractionMode, new_id
from app.services.audio_utils import audio_data_url
from app.services.openai_gateway import OpenAIGateway
from app.services.session_store import InMemorySessionStore, Turn


class AvatarConversationService:
    """Application service that composes reply generation, TTS, and session state."""

    def __init__(self, *, settings: Settings, openai: OpenAIGateway, sessions: InMemorySessionStore) -> None:
        self.settings = settings
        self.openai = openai
        self.sessions = sessions

    async def create_conversation(self):
        return self.sessions.create()

    async def send_message(
        self,
        *,
        conversation_id: str,
        message: str,
        voice: str | None,
        interaction_mode: InteractionMode = InteractionMode.chat,
    ) -> ChatResponse:
        state = self.sessions.get_or_create(conversation_id)

        reply, response_id, usage = await self.openai.create_avatar_reply(
            user_message=message,
            previous_response_id=state.last_response_id,
            interaction_mode=interaction_mode,
        )
        audio_bytes = await self.openai.create_speech(text=reply.text, voice=voice)
        mime_type, data_url = audio_data_url(audio_bytes, self.settings.openai_tts_format)

        self.sessions.append_turn(
            state.conversation_id,
            Turn(
                user_text=message,
                assistant_text=reply.text,
                emotion=reply.emotion.value,
                response_id=response_id,
            ),
        )

        return ChatResponse(
            conversation_id=state.conversation_id,
            message_id=new_id("msg"),
            response_id=response_id,
            reply=reply,
            audio=AudioPayload(mime_type=mime_type, format=self.settings.openai_tts_format, data_url=data_url),
            usage=usage,
        )
