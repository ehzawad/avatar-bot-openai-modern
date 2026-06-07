from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables or an optional .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Aria OpenAI Avatar"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    environment: str = "local"

    openai_api_key: str = Field(default="", validation_alias="OPENAI_API_KEY")
    openai_base_url: str = Field(default="https://api.openai.com/v1", validation_alias="OPENAI_BASE_URL")
    openai_response_model: str = Field(default="gpt-5.4-mini", validation_alias="OPENAI_RESPONSE_MODEL")
    openai_tts_model: str = Field(default="gpt-4o-mini-tts", validation_alias="OPENAI_TTS_MODEL")
    openai_transcribe_model: str = Field(default="gpt-4o-mini-transcribe", validation_alias="OPENAI_TRANSCRIBE_MODEL")
    openai_transcribe_model_fast: str = Field(default="gpt-4o-mini-transcribe", validation_alias="OPENAI_TRANSCRIBE_MODEL_FAST")
    openai_transcribe_model_best: str = Field(default="gpt-4o-transcribe", validation_alias="OPENAI_TRANSCRIBE_MODEL_BEST")
    openai_transcribe_model_diarize: str = Field(default="gpt-4o-transcribe-diarize", validation_alias="OPENAI_TRANSCRIBE_MODEL_DIARIZE")
    data_dir: str = Field(default="data", validation_alias="DATA_DIR")
    dataset_page_size_default: int = Field(default=50, gt=0, validation_alias="DATASET_PAGE_SIZE_DEFAULT")
    openai_tts_voice: str = Field(default="alloy", validation_alias="OPENAI_TTS_VOICE")
    openai_tts_format: Literal["mp3", "opus", "aac", "flac", "wav", "pcm"] = Field(
        default="mp3", validation_alias="OPENAI_TTS_FORMAT"
    )
    openai_request_timeout_seconds: float = Field(default=60.0, validation_alias="OPENAI_REQUEST_TIMEOUT_SECONDS")

    max_input_chars: int = 4000
    max_tts_chars: int = 4096
    max_upload_bytes: int = 25 * 1024 * 1024
    session_ttl_seconds: int = 60 * 60 * 6

    @property
    def openai_enabled(self) -> bool:
        return bool(self.openai_api_key.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
