from __future__ import annotations

import base64


MIME_BY_FORMAT = {
    "mp3": "audio/mpeg",
    "opus": "audio/opus",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "pcm": "audio/pcm",
}


def audio_data_url(audio_bytes: bytes, audio_format: str) -> tuple[str, str]:
    mime = MIME_BY_FORMAT.get(audio_format, "application/octet-stream")
    encoded = base64.b64encode(audio_bytes).decode("ascii")
    return mime, f"data:{mime};base64,{encoded}"
