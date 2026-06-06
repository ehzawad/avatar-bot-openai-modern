from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import status

from app.core.config import Settings
from app.core.errors import OpenAIServiceError
from app.domain.prompts import AVATAR_DEVELOPER_PROMPT, LIVE_INTERVIEW_INSTRUCTIONS, TTS_VOICE_INSTRUCTIONS
from app.domain.schemas import AvatarReply, InteractionMode


AVATAR_REPLY_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "text": {
            "type": "string",
            "description": "The exact user-facing text Aria should say aloud.",
        },
        "emotion": {
            "type": "string",
            "enum": ["neutral", "joy", "sorrow", "angry", "fun", "surprised"],
            "description": "The facial expression to render.",
        },
        "gesture": {
            "type": "string",
            "enum": ["idle", "nod", "shake", "lean_in", "wave"],
            "description": "A small nonverbal body cue for the frontend animation layer.",
        },
        "listen_hint": {
            "type": "string",
            "description": "Very short hint for the UI about what Aria is doing or inviting next. Empty string is allowed.",
        },
    },
    "required": ["text", "emotion", "gesture", "listen_hint"],
}


class OpenAIGateway:
    """Thin direct-HTTP adapter for OpenAI endpoints.

    Keeping this as direct HTTP makes endpoint boundaries explicit and keeps the rest of
    the app independent of a specific SDK surface. Replace only this class to swap providers.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.openai_base_url.rstrip("/"),
            timeout=httpx.Timeout(settings.openai_request_timeout_seconds),
        )

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        if not self.settings.openai_enabled:
            raise OpenAIServiceError(
                "OPENAI_API_KEY is not set. Export it in your shell before starting the app.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return {
            "Authorization": f"Bearer {self.settings.openai_api_key}",
            "Content-Type": "application/json",
        }

    async def create_avatar_reply(
        self,
        *,
        user_message: str,
        previous_response_id: str | None,
        interaction_mode: InteractionMode = InteractionMode.chat,
    ) -> tuple[AvatarReply, str | None, dict[str, Any] | None]:
        instructions = AVATAR_DEVELOPER_PROMPT
        if interaction_mode == InteractionMode.live_interview:
            instructions = f"{instructions}\n\n{LIVE_INTERVIEW_INSTRUCTIONS}"

        payload: dict[str, Any] = {
            "model": self.settings.openai_response_model,
            "instructions": instructions,
            "input": user_message,
            "store": True,
            "max_output_tokens": 350,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "avatar_reply",
                    "description": "A structured reply for a real-time 3D talking avatar.",
                    "strict": True,
                    "schema": AVATAR_REPLY_JSON_SCHEMA,
                },
                "verbosity": "low",
            },
        }
        if previous_response_id:
            payload["previous_response_id"] = previous_response_id

        data = await self._post_json("/responses", payload)
        output_text = self._extract_output_text(data)
        try:
            parsed = json.loads(output_text)
            reply = AvatarReply.model_validate(parsed)
        except Exception as exc:  # noqa: BLE001 - convert opaque provider payload to app-level error
            raise OpenAIServiceError(
                "OpenAI response did not match the avatar reply schema.",
                status.HTTP_502_BAD_GATEWAY,
                {"raw_output": output_text, "error": str(exc)},
            ) from exc

        return reply, data.get("id"), data.get("usage")

    async def create_speech(self, *, text: str, voice: str | None) -> bytes:
        payload: dict[str, Any] = {
            "model": self.settings.openai_tts_model,
            "input": text[: self.settings.max_tts_chars],
            "voice": voice or self.settings.openai_tts_voice,
            "response_format": self.settings.openai_tts_format,
            "instructions": TTS_VOICE_INSTRUCTIONS,
        }

        if self.settings.openai_tts_model in {"tts-1", "tts-1-hd"}:
            # The current speech endpoint documents voice instructions as unsupported for tts-1/tts-1-hd.
            payload.pop("instructions", None)

        response = await self._client.post("/audio/speech", headers=self._headers(), json=payload)
        if response.status_code >= 400:
            raise self._provider_error("OpenAI speech request failed.", response)
        return response.content

    async def transcribe(self, *, audio_bytes: bytes, filename: str, content_type: str | None) -> str:
        if not audio_bytes:
            raise OpenAIServiceError("No audio was uploaded.", status.HTTP_400_BAD_REQUEST)
        if len(audio_bytes) > self.settings.max_upload_bytes:
            raise OpenAIServiceError("Uploaded audio is larger than the configured limit.", status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)

        files = {
            "file": (filename or "recording.webm", audio_bytes, content_type or "audio/webm"),
        }
        data = {
            "model": self.settings.openai_transcribe_model,
            "response_format": "json",
        }
        headers = {"Authorization": f"Bearer {self.settings.openai_api_key}"}
        if not self.settings.openai_enabled:
            raise OpenAIServiceError(
                "OPENAI_API_KEY is not set. Export it in your shell before starting the app.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        response = await self._client.post("/audio/transcriptions", headers=headers, data=data, files=files)
        if response.status_code >= 400:
            raise self._provider_error("OpenAI transcription request failed.", response)
        try:
            payload = response.json()
        except ValueError:
            return response.text.strip()
        return str(payload.get("text", "")).strip()

    async def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = await self._client.post(path, headers=self._headers(), json=payload)
        if response.status_code >= 400:
            raise self._provider_error("OpenAI request failed.", response)
        try:
            return response.json()
        except ValueError as exc:
            raise OpenAIServiceError("OpenAI returned non-JSON data.", status.HTTP_502_BAD_GATEWAY) from exc

    def _provider_error(self, message: str, response: httpx.Response) -> OpenAIServiceError:
        try:
            details: Any = response.json()
        except ValueError:
            details = response.text[:2000]
        return OpenAIServiceError(message, response.status_code, details)

    @staticmethod
    def _extract_output_text(data: dict[str, Any]) -> str:
        if isinstance(data.get("output_text"), str) and data["output_text"].strip():
            return data["output_text"].strip()

        chunks: list[str] = []
        for item in data.get("output", []) or []:
            if item.get("type") != "message":
                continue
            for content in item.get("content", []) or []:
                if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                    chunks.append(content["text"])
        text = "".join(chunks).strip()
        if not text:
            raise OpenAIServiceError("OpenAI response did not contain output text.", status.HTTP_502_BAD_GATEWAY, data)
        return text
