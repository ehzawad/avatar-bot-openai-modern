// Avatar page shell (WEB_CONTRACT §9). Full-window canvas behind glassy panels.
//
// Wires together: health/config queries, the AudioPlayer (imperative), the shared
// recorder, the chat state machine (useAvatarChat), and the Three.js scene bridge
// (useAvatarScene). The scene reads getMouthLevel() inside its RAF loop.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';

import * as api from '../../lib/api/avatarClient';
import type { Emotion, Gesture, HealthResponse, PublicConfig } from '../../lib/api/types';
import { useRecorder } from '../../lib/audio/useRecorder';

import { AudioPlayer } from './audio/AudioPlayer';
import { useAvatarChat, type StatusTone } from './hooks/useAvatarChat';
import { useAvatarScene, type GestureEvent, type EmotionEvent } from './scene/useAvatarScene';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { RuntimePanel } from './components/RuntimePanel';
import { StatusPill } from './components/StatusPill';

import './avatar.css';

export default function AvatarApp() {
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // ONE AudioPlayer for the lifetime of the page.
  const audioPlayer = useMemo(() => new AudioPlayer(), []);
  useEffect(() => () => audioPlayer.dispose(), [audioPlayer]);

  const recorder = useRecorder();

  // --- boot queries: health + config -------------------------------------
  const healthQuery = useQuery<HealthResponse, Error>({
    queryKey: ['avatar', 'health'],
    queryFn: ({ signal }) => api.health(signal),
    staleTime: Infinity,
    retry: 1,
  });
  const configQuery = useQuery<PublicConfig, Error>({
    queryKey: ['avatar', 'config'],
    queryFn: ({ signal }) => api.config(signal),
    staleTime: Infinity,
    retry: 1,
  });

  const config = configQuery.data ?? null;
  const defaultVoice = config?.default_voice ?? '';

  // --- scene cues: emotion + gesture are both EVENTS ---------------------
  // (the runtime auto-resets emotion after ~4.8s, so a repeated identical emotion must
  // re-fire — hence an event with a fresh id per reply, not gated durable state).
  const [emotionEvent, setEmotionEvent] = useState<EmotionEvent | null>(null);
  const [gestureEvent, setGestureEvent] = useState<GestureEvent | null>(null);
  const cueSeqRef = useRef(0);

  const onAvatarCue = useCallback((cue: { emotion: Emotion; gesture: Gesture }) => {
    cueSeqRef.current += 1;
    const id = `c${cueSeqRef.current}`;
    setEmotionEvent({ id, type: cue.emotion });
    setGestureEvent({ id, type: cue.gesture });
  }, []);

  const chat = useAvatarChat({
    audioPlayer,
    recorder,
    defaultVoice,
    onAvatarCue,
  });

  // --- scene bridge -------------------------------------------------------
  const getMouthLevel = useCallback(() => audioPlayer.getMouthLevel(), [audioPlayer]);
  const { loadUploadedFile } = useAvatarScene(canvasRef, {
    getMouthLevel,
    emotionEvent,
    gestureEvent,
    modelUrl: null, // uploads go through loadUploadedFile; null => procedural fallback
  });

  // --- boot side-effects: surface health/config state once ---------------
  const bootHandledRef = useRef(false);
  useEffect(() => {
    if (bootHandledRef.current) return;
    if (healthQuery.isLoading || configQuery.isLoading) return;

    if (healthQuery.isError) {
      bootHandledRef.current = true;
      chat.setStatus('Backend unreachable', 'error');
      chat.pushSystemMessage(
        `Could not reach the backend: ${healthQuery.error.message}`,
      );
      return;
    }
    if (configQuery.isError) {
      bootHandledRef.current = true;
      chat.setStatus('Config unavailable', 'error');
      chat.pushSystemMessage(`Could not load config: ${configQuery.error.message}`);
      return;
    }

    if (healthQuery.data) {
      bootHandledRef.current = true;
      if (!healthQuery.data.openai_configured) {
        chat.setStatus('Missing OPENAI_API_KEY', 'error');
        chat.pushSystemMessage(
          'OPENAI_API_KEY is not set. Stop the server, export the key in your shell, then restart.',
        );
      }
    }
  }, [
    healthQuery.isLoading,
    healthQuery.isError,
    healthQuery.data,
    healthQuery.error,
    configQuery.isLoading,
    configQuery.isError,
    configQuery.error,
    chat,
  ]);

  // The openai-not-configured error status must win even if conversation creation
  // resolves afterward and sets "Ready". Re-assert it whenever phase settles to idle.
  const openaiMissing = healthQuery.data ? !healthQuery.data.openai_configured : false;
  useEffect(() => {
    if (openaiMissing && chat.phase === 'idle' && chat.status.tone !== 'error') {
      chat.setStatus('Missing OPENAI_API_KEY', 'error');
    }
  }, [openaiMissing, chat.phase, chat.status.tone, chat]);

  // --- mic / recording wiring --------------------------------------------
  const recording = recorder.state === 'recording' || recorder.state === 'requesting_mic';

  const onMicClick = useCallback(() => {
    if (chat.liveMode) {
      chat.toggleLiveMode(); // exit live
      return;
    }
    if (chat.canStop) {
      chat.stopRecording();
      return;
    }
    chat.startManualRecording();
  }, [chat]);

  const onModelStatus = useCallback(
    (label: string, tone: 'busy' | 'ready' | 'error') => {
      chat.setStatus(label, tone as StatusTone);
    },
    [chat],
  );

  return (
    <div className="avatar-app">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <div ref={canvasRef} className="canvas-root" aria-label="3D avatar viewport" />

      <header className="panel topbar">
        <div>
          <div className="eyebrow">OpenAI Responses API avatar</div>
          <h1>Aria</h1>
        </div>
        <div className="topbar-right">
          <Link className="nav-link" to="/">
            Home
          </Link>
          <Link className="nav-link" to="/studio">
            Studio
          </Link>
          <StatusPill label={chat.status.label} tone={chat.status.tone} />
        </div>
      </header>

      <main className="side-stack">
        <section className="panel chat-panel">
          <div className="panel-title">
            <span>Conversation</span>
            <button
              type="button"
              className="ghost-button"
              onClick={chat.newChat}
              disabled={chat.phase !== 'idle' && chat.phase !== 'error'}
            >
              New
            </button>
          </div>
          <ChatView messages={chat.messages} />
        </section>

        <RuntimePanel
          config={config}
          voice={chat.voice}
          onVoiceChange={chat.setVoice}
          onModelFile={loadUploadedFile}
          onStatus={onModelStatus}
          onMessage={chat.pushSystemMessage}
        />
      </main>

      <Composer
        liveMode={chat.liveMode}
        recording={recording}
        canSend={chat.canSend}
        canRecord={chat.canRecord}
        canStop={chat.canStop}
        micLevel={chat.micLevel}
        onSend={chat.sendTyped}
        onMicClick={onMicClick}
        onToggleLive={chat.toggleLiveMode}
      />
    </div>
  );
}
