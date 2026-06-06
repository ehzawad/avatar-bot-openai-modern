# Live Interview Mode

Live interview mode makes Aria feel closer to a human interviewer or live support agent without exposing the OpenAI API key to the browser.

## Runtime Flow

1. The user turns on `Live`.
2. The browser starts microphone capture after the browser permission prompt.
3. `MicRecorder` watches the microphone level with a Web Audio analyser.
4. After speech starts, a short silence is treated as the end of the user's turn.
5. The browser sends the captured audio to `/api/speech/transcriptions`.
6. The transcript is sent to `/api/conversations/{conversation_id}/messages` with `interaction_mode: "live_interview"`.
7. The backend adds live-interview instructions to the OpenAI Responses request.
8. Aria plays the TTS audio reply.
9. When playback ends, the browser starts listening again if `Live` is still on.

## Turn-Taking Settings

The browser owns pause detection in `frontend/src/audio/recorder.js` and `frontend/src/app.js`.

- `speechThreshold`: microphone RMS level needed to count as speech.
- `silenceMs`: pause duration before a live turn is submitted.
- `minSpeechMs`: minimum speech duration before silence can end a turn.
- `idleTimeoutMs`: resets the recorder if live mode is open and nobody speaks.

The current defaults are tuned for local demos: quick enough for interview flow, but conservative enough to avoid sending the first small noise as a turn.

## API Contract

Message requests must include `interaction_mode`.

```json
{
  "message": "I just finished describing my last project.",
  "voice": "alloy",
  "interaction_mode": "live_interview"
}
```

Use `chat` for typed/manual turns and `live_interview` for pause-detected turns.

## Limits

This mode is pause-detected turn-taking over the existing REST, transcription, Responses, and TTS endpoints. It is not a WebRTC streaming session. The implementation is intentionally scoped so the existing avatar, transcript, and TTS architecture stays simple and debuggable.
