// Avatar chat state machine (WEB_CONTRACT §8). NO Three imports.
//
// Ports frontend/src/app.js turn logic into a reducer-driven hook with synchronous
// race guards: a turn token (turnSeqRef + activeTurnRef{id,source,abort}), a live
// epoch (liveEpochRef), and latest-refs for phase/liveMode. Transport goes through
// the shared TanStack mutations; transcript/phase/loop are LOCAL reducer state.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';

import {
  useCreateConversation,
  useSendMessage,
  useTranscribe,
} from '../../../lib/api/avatarMutations';
import type { Emotion, Gesture, InteractionMode } from '../../../lib/api/types';
import { useLatest } from '../../../lib/hooks/useLatest';
import type { UseRecorderResult } from '../../../lib/audio/useRecorder';
import type { AudioPlayer, PlaybackResult } from '../audio/AudioPlayer';

// --- phases / status --------------------------------------------------------

export type Phase =
  | 'creating'
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

export type StatusTone = 'ready' | 'busy' | 'speaking' | 'error';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: ReactNode;
}

export interface AvatarCue {
  emotion: Emotion;
  gesture: Gesture;
}

export interface UseAvatarChatArgs {
  audioPlayer: AudioPlayer;
  recorder: UseRecorderResult;
  defaultVoice: string;
  onAvatarCue: (cue: AvatarCue) => void;
}

export interface UseAvatarChatResult {
  phase: Phase;
  status: { label: string; tone: StatusTone };
  messages: ChatMessage[];
  conversationId: string | null;
  voice: string;
  liveMode: boolean;
  micLevel: number;
  canSend: boolean;
  canRecord: boolean;
  canStop: boolean;
  setVoice: (voice: string) => void;
  sendTyped: (text: string) => void;
  startManualRecording: () => void;
  stopRecording: () => void;
  toggleLiveMode: () => void;
  newChat: () => void;
  /** Surface a system message (e.g. boot health/config warnings). */
  pushSystemMessage: (text: ReactNode) => void;
  /** Set status explicitly (e.g. boot states), without changing phase semantics. */
  setStatus: (label: string, tone: StatusTone) => void;
}

// --- reducer ----------------------------------------------------------------

interface State {
  phase: Phase;
  status: { label: string; tone: StatusTone };
  messages: ChatMessage[];
  conversationId: string | null;
  voice: string;
  liveMode: boolean;
}

type Action =
  | { type: 'phase'; phase: Phase }
  | { type: 'status'; label: string; tone: StatusTone }
  | { type: 'phase+status'; phase: Phase; label: string; tone: StatusTone }
  | { type: 'addMessage'; message: ChatMessage }
  | { type: 'clearMessages' }
  | { type: 'conversation'; id: string | null }
  | { type: 'voice'; voice: string }
  | { type: 'liveMode'; value: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'phase':
      return { ...state, phase: action.phase };
    case 'status':
      return { ...state, status: { label: action.label, tone: action.tone } };
    case 'phase+status':
      return {
        ...state,
        phase: action.phase,
        status: { label: action.label, tone: action.tone },
      };
    case 'addMessage':
      return { ...state, messages: [...state.messages, action.message] };
    case 'clearMessages':
      return { ...state, messages: [] };
    case 'conversation':
      return { ...state, conversationId: action.id };
    case 'voice':
      return { ...state, voice: action.voice };
    case 'liveMode':
      return { ...state, liveMode: action.value };
    default:
      return state;
  }
}

// Live preset (matches legacy startLiveListening / WEB_CONTRACT §5).
const LIVE_OPTS = {
  mode: 'live' as const,
  autoStopOnSilence: true,
  silenceMs: 950,
  minSpeechMs: 360,
  speechThreshold: 0.035,
  warmupMs: 250,
  idleTimeoutMs: 15000,
};

let messageSeq = 0;
function nextMessageId(): string {
  messageSeq += 1;
  return `m${messageSeq}-${Date.now()}`;
}

let turnSeq = 0;

type TurnSource = 'typed' | 'manual' | 'live';

interface ActiveTurn {
  id: number;
  source: TurnSource;
  abort: AbortController;
  liveEpoch: number;
}

export function useAvatarChat({
  audioPlayer,
  recorder,
  defaultVoice,
  onAvatarCue,
}: UseAvatarChatArgs): UseAvatarChatResult {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    phase: 'creating' as Phase,
    status: { label: 'Booting', tone: 'busy' as StatusTone },
    messages: [] as ChatMessage[],
    conversationId: null as string | null,
    voice: defaultVoice,
    liveMode: false,
  }));

  const createConversation = useCreateConversation();
  const transcribe = useTranscribe();
  const sendMessage = useSendMessage();

  // Latest-refs for synchronous guards.
  const phaseRef = useLatest(state.phase);
  const liveModeRef = useLatest(state.liveMode);
  const conversationIdRef = useLatest(state.conversationId);
  const voiceRef = useLatest(state.voice);

  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const liveEpochRef = useRef(0);
  const liveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlockedRef = useRef(false);
  const mountedRef = useRef(true);

  // Stable refs for mutateAsync (avoid re-creating callbacks each render).
  const createAsync = useLatest(createConversation.mutateAsync);
  const transcribeAsync = useLatest(transcribe.mutateAsync);
  const sendAsync = useLatest(sendMessage.mutateAsync);
  const recorderRef = useLatest(recorder);
  const onAvatarCueRef = useLatest(onAvatarCue);

  // Keep default voice in sync once config loads (only if user hasn't changed it).
  const userPickedVoiceRef = useRef(false);
  useEffect(() => {
    if (!userPickedVoiceRef.current && defaultVoice) {
      dispatch({ type: 'voice', voice: defaultVoice });
    }
  }, [defaultVoice]);

  // --- helpers ------------------------------------------------------------

  const addMessage = useCallback((role: ChatRole, text: ReactNode): void => {
    dispatch({ type: 'addMessage', message: { id: nextMessageId(), role, text } });
  }, []);

  const unlockAudio = useCallback((): void => {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    void audioPlayer.unlock();
  }, [audioPlayer]);

  const clearLiveTimeout = useCallback((): void => {
    if (liveTimeoutRef.current !== null) {
      clearTimeout(liveTimeoutRef.current);
      liveTimeoutRef.current = null;
    }
  }, []);

  const isCurrentTurn = useCallback((turn: ActiveTurn): boolean => {
    return activeTurnRef.current === turn && !turn.abort.signal.aborted;
  }, []);

  const endTurn = useCallback((turn: ActiveTurn): void => {
    if (activeTurnRef.current === turn) activeTurnRef.current = null;
  }, []);

  // Synchronously begins a turn iff idle. Returns the token or null.
  const beginTurn = useCallback((source: TurnSource): ActiveTurn | null => {
    if (phaseRef.current !== 'idle') return null;
    turnSeq += 1;
    const turn: ActiveTurn = {
      id: turnSeq,
      source,
      abort: new AbortController(),
      liveEpoch: liveEpochRef.current,
    };
    activeTurnRef.current = turn;
    return turn;
  }, [phaseRef]);

  const ensureConversation = useCallback(
    async (turn: ActiveTurn): Promise<string | null> => {
      const existing = conversationIdRef.current;
      if (existing) return existing;
      const created = await createAsync.current({ signal: turn.abort.signal });
      if (!isCurrentTurn(turn)) return null;
      dispatch({ type: 'conversation', id: created.conversation_id });
      return created.conversation_id;
    },
    [conversationIdRef, createAsync, isCurrentTurn],
  );

  const scheduleLiveListening = useCallback(
    (delayMs: number): void => {
      clearLiveTimeout();
      const epoch = liveEpochRef.current;
      liveTimeoutRef.current = setTimeout(() => {
        liveTimeoutRef.current = null;
        if (!mountedRef.current) return;
        if (
          liveModeRef.current &&
          epoch === liveEpochRef.current &&
          phaseRef.current === 'idle' &&
          !audioPlayer.isPlaying()
        ) {
          void runTurn('live');
        }
      }, delayMs);
    },
    // runTurn defined below; deps intentionally limited (refs are stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audioPlayer, clearLiveTimeout, liveModeRef, phaseRef],
  );

  // Core pipeline: typed/manual/live. Synchronous-guard at every async hop.
  const runTurn = useCallback(
    async (source: TurnSource, typedText?: string): Promise<void> => {
      // Audio must be unlocked from a user gesture before any playback.
      unlockAudio();

      const turn = beginTurn(source);
      if (!turn) return;

      try {
        let userText = typedText ?? '';

        // --- mic capture (manual/live) ---
        if (source !== 'typed') {
          dispatch({
            type: 'phase+status',
            phase: 'listening',
            label: 'Listening',
            tone: 'busy',
          });
          // Stop any current playback before listening.
          audioPlayer.stop();

          let result;
          try {
            const handle = await recorderRef.current.start(
              source === 'live' ? LIVE_OPTS : { mode: 'manual' },
            );
            if (!isCurrentTurn(turn)) {
              recorderRef.current.cancel();
              return;
            }
            result = await handle.finished;
          } catch (err) {
            // cancelled / mic-denied
            if (!isCurrentTurn(turn)) return;
            throw err;
          }
          if (!isCurrentTurn(turn)) return;

          // Idle live capture (no speech) — loop again without an error.
          if (result.reason === 'idle' || result.reason === 'cancel') {
            endTurn(turn);
            dispatch({ type: 'phase', phase: 'idle' });
            if (liveModeRef.current && turn.liveEpoch === liveEpochRef.current) {
              scheduleLiveListening(300);
            } else {
              dispatch({ type: 'status', label: 'Ready', tone: 'ready' });
            }
            return;
          }

          if (!result.blob || result.blob.size < 100) {
            endTurn(turn);
            dispatch({ type: 'phase', phase: 'idle' });
            if (liveModeRef.current && turn.liveEpoch === liveEpochRef.current) {
              dispatch({ type: 'status', label: 'Listening', tone: 'busy' });
              scheduleLiveListening(250);
            } else {
              dispatch({ type: 'status', label: 'Ready', tone: 'ready' });
            }
            return;
          }

          dispatch({
            type: 'phase+status',
            phase: 'transcribing',
            label: source === 'live' ? 'Pause detected' : 'Transcribing',
            tone: 'busy',
          });
          const tr = await transcribeAsync.current({
            audio: result.blob,
            filename: 'speech.webm',
            signal: turn.abort.signal,
          });
          if (!isCurrentTurn(turn)) return;

          if (!tr.text) {
            if (source !== 'live') addMessage('system', 'No speech was detected.');
            endTurn(turn);
            dispatch({ type: 'phase', phase: 'idle' });
            if (liveModeRef.current && turn.liveEpoch === liveEpochRef.current) {
              dispatch({ type: 'status', label: 'Listening', tone: 'busy' });
              scheduleLiveListening(300);
            } else {
              dispatch({ type: 'status', label: 'Ready', tone: 'ready' });
            }
            return;
          }
          userText = tr.text;
        }

        if (!userText.trim()) {
          endTurn(turn);
          dispatch({ type: 'phase', phase: 'idle' });
          return;
        }

        // --- conversation + user message ---
        const convId = await ensureConversation(turn);
        if (!isCurrentTurn(turn) || !convId) return;

        addMessage('user', userText);

        dispatch({
          type: 'phase+status',
          phase: 'thinking',
          label: 'Thinking',
          tone: 'busy',
        });
        // Stop any lingering playback before requesting the new reply.
        audioPlayer.stop();

        const interactionMode: InteractionMode =
          source === 'live' ? 'live_interview' : liveModeRef.current ? 'live_interview' : 'chat';

        const response = await sendAsync.current({
          conversationId: convId,
          message: userText,
          voice: voiceRef.current,
          interactionMode,
          signal: turn.abort.signal,
        });
        if (!isCurrentTurn(turn)) return;

        addMessage('assistant', response.reply.text);
        onAvatarCueRef.current({
          emotion: response.reply.emotion,
          gesture: response.reply.gesture,
        });

        // --- play TTS ---
        dispatch({
          type: 'phase+status',
          phase: 'speaking',
          label: 'Speaking',
          tone: 'speaking',
        });
        const playback: PlaybackResult = await audioPlayer.playDataUrl(
          response.audio.data_url,
          turn.id,
        );

        // A newer turn took over playback — let it own the state.
        if (playback === 'superseded') return;
        if (!isCurrentTurn(turn)) return;

        endTurn(turn);
        dispatch({ type: 'phase', phase: 'idle' });

        // Live loop: only continue if audio ENDED naturally (not stopped) and we're
        // still in the same live epoch.
        if (
          playback === 'ended' &&
          liveModeRef.current &&
          turn.liveEpoch === liveEpochRef.current
        ) {
          dispatch({ type: 'status', label: 'Listening', tone: 'busy' });
          scheduleLiveListening(250);
        } else {
          dispatch({ type: 'status', label: 'Ready', tone: 'ready' });
        }
      } catch (err) {
        if (!isCurrentTurn(turn)) {
          // Superseded/aborted — ignore.
          return;
        }
        endTurn(turn);
        const aborted =
          (err as { name?: string })?.name === 'AbortError' || turn.abort.signal.aborted;
        if (aborted) {
          dispatch({ type: 'phase', phase: 'idle' });
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Something went wrong. Please try again.';
        const isMic = source !== 'typed' && /microphone|getusermedia|permission|denied/i.test(message);
        // eslint-disable-next-line no-console
        console.error(err);
        addMessage('system', message);
        dispatch({
          type: 'phase+status',
          phase: 'error',
          label: isMic ? 'Microphone blocked' : 'Reply failed',
          tone: 'error',
        });
      }
    },
    [
      addMessage,
      audioPlayer,
      beginTurn,
      endTurn,
      ensureConversation,
      isCurrentTurn,
      liveEpochRef,
      liveModeRef,
      onAvatarCueRef,
      recorderRef,
      scheduleLiveListening,
      sendAsync,
      transcribeAsync,
      unlockAudio,
      voiceRef,
    ],
  );

  // --- boot: create the first conversation --------------------------------
  const bootStartedRef = useRef(false);
  const startConversation = useCallback(
    async (showMessage: boolean): Promise<void> => {
      try {
        const created = await createAsync.current(undefined);
        if (!mountedRef.current) return;
        dispatch({ type: 'conversation', id: created.conversation_id });
        dispatch({ type: 'clearMessages' });
        if (showMessage) {
          addMessage('system', 'Started a new conversation.');
        } else {
          addMessage(
            'system',
            'Ready. Your API key stays on the server; the browser never sees it.',
          );
        }
        dispatch({ type: 'phase+status', phase: 'idle', label: 'Ready', tone: 'ready' });
      } catch (err) {
        if (!mountedRef.current) return;
        // eslint-disable-next-line no-console
        console.error(err);
        addMessage(
          'system',
          err instanceof Error ? err.message : 'Failed to start a conversation.',
        );
        dispatch({
          type: 'phase+status',
          phase: 'error',
          label: 'Boot failed',
          tone: 'error',
        });
      }
    },
    [addMessage, createAsync],
  );

  useEffect(() => {
    if (bootStartedRef.current) return;
    bootStartedRef.current = true;
    void startConversation(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- public actions -----------------------------------------------------

  const setVoice = useCallback((voice: string): void => {
    userPickedVoiceRef.current = true;
    dispatch({ type: 'voice', voice });
  }, []);

  const sendTyped = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (phaseRef.current !== 'idle') return;
      void runTurn('typed', trimmed);
    },
    [phaseRef, runTurn],
  );

  const startManualRecording = useCallback((): void => {
    if (liveModeRef.current) return;
    if (phaseRef.current !== 'idle') return;
    void runTurn('manual');
  }, [liveModeRef, phaseRef, runTurn]);

  const stopRecording = useCallback((): void => {
    // Stop the active mic capture (resolves recorder session -> pipeline continues).
    recorderRef.current.stop('manual');
  }, [recorderRef]);

  const stopLive = useCallback((): void => {
    clearLiveTimeout();
    liveEpochRef.current += 1; // invalidate any scheduled listen
    dispatch({ type: 'liveMode', value: false });
    // Cancel an in-flight live capture if it's the current turn.
    const turn = activeTurnRef.current;
    if (turn && turn.source === 'live') {
      recorderRef.current.cancel();
      turn.abort.abort();
      activeTurnRef.current = null;
      dispatch({ type: 'phase+status', phase: 'idle', label: 'Ready', tone: 'ready' });
    } else if (phaseRef.current === 'listening') {
      recorderRef.current.cancel();
    } else if (phaseRef.current === 'idle') {
      dispatch({ type: 'status', label: 'Ready', tone: 'ready' });
    }
  }, [clearLiveTimeout, liveEpochRef, phaseRef, recorderRef]);

  const toggleLiveMode = useCallback((): void => {
    unlockAudio();
    if (liveModeRef.current) {
      stopLive();
      return;
    }
    dispatch({ type: 'liveMode', value: true });
    liveEpochRef.current += 1;
    // If something is already playing or busy, start the loop after it settles
    // (the speaking branch schedules a listen on natural end). Otherwise begin now.
    if (phaseRef.current === 'idle' && !audioPlayer.isPlaying()) {
      void runTurn('live');
    } else if (audioPlayer.isPlaying()) {
      dispatch({ type: 'status', label: 'Live after reply', tone: 'busy' });
    }
  }, [audioPlayer, liveEpochRef, liveModeRef, phaseRef, runTurn, stopLive, unlockAudio]);

  const newChat = useCallback((): void => {
    unlockAudio();
    // Cancel recorder, abort fetches, stop audio, clear live timeout, bump epochs.
    clearLiveTimeout();
    liveEpochRef.current += 1;
    const turn = activeTurnRef.current;
    if (turn) {
      turn.abort.abort();
      activeTurnRef.current = null;
    }
    recorderRef.current.cancel();
    audioPlayer.stop();
    dispatch({ type: 'liveMode', value: false });
    dispatch({ type: 'clearMessages' });
    dispatch({ type: 'conversation', id: null });
    dispatch({ type: 'phase+status', phase: 'creating', label: 'Starting', tone: 'busy' });
    void startConversation(true);
  }, [audioPlayer, clearLiveTimeout, liveEpochRef, recorderRef, startConversation, unlockAudio]);

  const pushSystemMessage = useCallback(
    (text: ReactNode): void => {
      addMessage('system', text);
    },
    [addMessage],
  );

  const setStatus = useCallback((label: string, tone: StatusTone): void => {
    dispatch({ type: 'status', label, tone });
  }, []);

  // --- cleanup ------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearLiveTimeout();
      liveEpochRef.current += 1;
      activeTurnRef.current?.abort.abort();
      activeTurnRef.current = null;
    };
  }, [clearLiveTimeout, liveEpochRef]);

  // --- derived UI flags ---------------------------------------------------
  const canSend = state.phase === 'idle' && !state.liveMode;
  const canRecord = (state.phase === 'idle' || state.phase === 'listening') && !state.liveMode;
  const canStop = state.phase === 'listening';

  const micLevel = recorder.level;

  return useMemo<UseAvatarChatResult>(
    () => ({
      phase: state.phase,
      status: state.status,
      messages: state.messages,
      conversationId: state.conversationId,
      voice: state.voice,
      liveMode: state.liveMode,
      micLevel,
      canSend,
      canRecord,
      canStop,
      setVoice,
      sendTyped,
      startManualRecording,
      stopRecording,
      toggleLiveMode,
      newChat,
      pushSystemMessage,
      setStatus,
    }),
    [
      state.phase,
      state.status,
      state.messages,
      state.conversationId,
      state.voice,
      state.liveMode,
      micLevel,
      canSend,
      canRecord,
      canStop,
      setVoice,
      sendTyped,
      startManualRecording,
      stopRecording,
      toggleLiveMode,
      newChat,
      pushSystemMessage,
      setStatus,
    ],
  );
}
