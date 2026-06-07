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

    async def transcribe(
        self,
        *,
        audio_bytes: bytes,
        filename: str,
        content_type: str | None,
        model: str | None = None,
        language: str | None = None,
        prompt: str | None = None,
        response_format: str = "json",
        extra_fields: dict[str, str] | None = None,
    ) -> dict:
        """Transcribe audio and return the parsed provider JSON dict.

        Backward compatible: callers that omit the new keyword arguments get a dict whose
        ``["text"]`` key holds the transcript text (the legacy ``/api/speech`` route reads that).
        New callers can read ``result.get("logprobs")`` or segments as well.

        Behavior per contract:
          - ``language="auto"`` omits the ``language`` field entirely.
          - Always sends ``temperature=0`` (unless overridden via ``extra_fields``).
          - On a 4xx that mentions ``language``, retry once without the language field.
          - ``extra_fields`` values may be a string (single field) or a list of strings
            (emitted as a repeated multipart form field, e.g. ``include[]`` / ``timestamp_granularities[]``).
        """
        if not audio_bytes:
            raise OpenAIServiceError("No audio was uploaded.", status.HTTP_400_BAD_REQUEST)
        if len(audio_bytes) > self.settings.max_upload_bytes:
            raise OpenAIServiceError("Uploaded audio is larger than the configured limit.", status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        if not self.settings.openai_enabled:
            raise OpenAIServiceError(
                "OPENAI_API_KEY is not set. Export it in your shell before starting the app.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        headers = {"Authorization": f"Bearer {self.settings.openai_api_key}"}

        def build_data(include_language: bool) -> dict[str, Any]:
            # httpx only encodes multipart form fields when ``data`` is a Mapping (dict).
            # A list-of-tuples is mis-encoded as a sync-only body stream, which an AsyncClient
            # rejects. Repeated keys (include[], timestamp_granularities[]) are expressed as a
            # list VALUE on the dict, which httpx expands into repeated multipart fields.
            fields: dict[str, Any] = {
                "model": model or self.settings.openai_transcribe_model,
                "response_format": response_format,
                "temperature": "0",
            }
            if include_language and language and language.lower() != "auto":
                fields["language"] = language
            if prompt:
                fields["prompt"] = prompt
            for key, value in (extra_fields or {}).items():
                if isinstance(value, (list, tuple)):
                    fields[key] = [str(item) for item in value]
                else:
                    fields[key] = str(value)
            return fields

        files = {"file": (filename or "recording.webm", audio_bytes, content_type or "audio/webm")}

        async def do_post(include_language: bool) -> httpx.Response:
            return await self._client.post(
                "/audio/transcriptions",
                headers=headers,
                data=build_data(include_language),
                files=files,
            )

        include_language = bool(language and language.lower() != "auto")
        response = await do_post(include_language)

        if response.status_code >= 400 and include_language and 400 <= response.status_code < 500:
            # Retry once without the language field if the provider complained about language.
            body = response.text.lower()
            if "language" in body:
                response = await do_post(include_language=False)

        if response.status_code >= 400:
            raise self._provider_error("OpenAI transcription request failed.", response)

        try:
            payload = response.json()
        except ValueError:
            return {"text": response.text.strip()}
        if not isinstance(payload, dict):
            return {"text": str(payload).strip()}
        if "text" in payload and isinstance(payload["text"], str):
            payload["text"] = payload["text"].strip()
        return payload

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
