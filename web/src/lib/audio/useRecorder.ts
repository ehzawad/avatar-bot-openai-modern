// ONE shared recorder hook for the whole app (WEB_CONTRACT §5).
//
// Ports frontend/src/audio/recorder.js semantics (MediaRecorder + AnalyserNode
// RMS silence detection: warmup, minSpeech, silence, idleTimeout) into a React
// hook, while preserving the studio's manual-mode ergonomics.
//
// The avatar consumes the session model: `const { finished } = await start(opts)`
// then `await finished` to get the RecorderResult. The studio uses manual mode and
// reads `state`/`level` from the returned hook state.

import { useCallback, useEffect, useReducer, useRef } from 'react';

export type RecorderState = 'idle' | 'requesting_mic' | 'recording' | 'stopping';
export type RecorderMode = 'manual' | 'live';
export type StopReason = 'manual' | 'silence' | 'idle' | 'cancel';

export interface RecorderStartOptions {
  mode?: RecorderMode;
  autoStopOnSilence?: boolean;
  speechThreshold?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  warmupMs?: number;
  idleTimeoutMs?: number | null;
}

export interface RecorderResult {
  blob: Blob;
  durationMs: number;
  mode: RecorderMode;
  reason: StopReason;
  speechStarted: boolean;
}

export interface RecorderStartHandle {
  finished: Promise<RecorderResult>;
}

export interface UseRecorderResult {
  state: RecorderState;
  level: number;
  speaking: boolean;
  speechStarted: boolean;
  error: Error | null;
  /** Latest RMS level, readable inside RAF/meters without triggering re-render. */
  levelRef: { readonly current: number };
  start: (opts?: RecorderStartOptions) => Promise<RecorderStartHandle>;
  stop: (reason?: StopReason) => void;
  cancel: () => void;
  reset: () => void;
}

interface ReducerState {
  state: RecorderState;
  level: number;
  speaking: boolean;
  speechStarted: boolean;
  error: Error | null;
}

type Action =
  | { type: 'requesting' }
  | { type: 'recording' }
  | { type: 'stopping' }
  | { type: 'level'; level: number; speaking: boolean; speechStarted: boolean }
  | { type: 'finished' }
  | { type: 'error'; error: Error }
  | { type: 'reset' };

const INITIAL: ReducerState = {
  state: 'idle',
  level: 0,
  speaking: false,
  speechStarted: false,
  error: null,
};

function reducer(state: ReducerState, action: Action): ReducerState {
  switch (action.type) {
    case 'requesting':
      return { ...INITIAL, state: 'requesting_mic' };
    case 'recording':
      return { ...state, state: 'recording', error: null };
    case 'stopping':
      return { ...state, state: 'stopping' };
    case 'level':
      return {
        ...state,
        level: action.level,
        speaking: action.speaking,
        speechStarted: action.speechStarted,
      };
    case 'finished':
      return { ...state, state: 'idle', level: 0, speaking: false };
    case 'error':
      return { ...INITIAL, error: action.error };
    case 'reset':
      return INITIAL;
    default:
      return state;
  }
}

const MIME_PREFERRED = 'audio/webm;codecs=opus';
const MIME_FALLBACK = 'audio/webm';

// Live preset matches the legacy auto-stop tuning (WEB_CONTRACT §5).
const DEFAULT_OPTS: Required<RecorderStartOptions> = {
  mode: 'manual',
  autoStopOnSilence: false,
  speechThreshold: 0.035,
  silenceMs: 950,
  minSpeechMs: 360,
  warmupMs: 250,
  idleTimeoutMs: null,
};

interface Session {
  resolve: (result: RecorderResult) => void;
  reject: (err: Error) => void;
  opts: Required<RecorderStartOptions>;
  settled: boolean;
}

export function useRecorder(): UseRecorderResult {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Imperative refs (mirror the class fields in recorder.js).
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timeDataRef = useRef<Uint8Array | null>(null);
  const frameRef = useRef<number | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  const startedAtRef = useRef<number>(0);
  const speechStartedRef = useRef<boolean>(false);
  const speechStartedAtRef = useRef<number>(0);
  const lastVoiceAtRef = useRef<number>(0);
  const stopReasonRef = useRef<StopReason>('manual');
  const skipDispatchRef = useRef<boolean>(false);
  const sessionRef = useRef<Session | null>(null);
  const levelRef = useRef<number>(0);

  const stopMonitor = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current = null;
    timeDataRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    stopMonitor();
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    recorderRef.current = null;
    recordingRef.current = false;
    levelRef.current = 0;
  }, [stopMonitor]);

  const computeRms = useCallback((): number => {
    const analyser = analyserRef.current;
    const timeData = timeDataRef.current;
    if (!analyser || !timeData) return 0;
    // Cast to satisfy lib.dom typing variance across TS versions.
    analyser.getByteTimeDomainData(timeData as unknown as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const centered = (timeData[i] - 128) / 128;
      sum += centered * centered;
    }
    return Math.sqrt(sum / timeData.length);
  }, []);

  // Internal stop: triggers MediaRecorder.onstop, which resolves the session.
  const doStop = useCallback((reason: StopReason) => {
    stopReasonRef.current = reason;
    const recorder = recorderRef.current;
    if (recorder && recordingRef.current && recorder.state !== 'inactive') {
      if (mountedRef.current) dispatch({ type: 'stopping' });
      recorder.stop();
    }
  }, []);

  const startMonitor = useCallback(
    (opts: Required<RecorderStartOptions>) => {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass || !streamRef.current) return;

      const ctx = new AudioContextClass();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyserRef.current = analyser;
      timeDataRef.current = new Uint8Array(analyser.fftSize);
      const source = ctx.createMediaStreamSource(streamRef.current);
      sourceRef.current = source;
      source.connect(analyser);

      const tick = () => {
        if (!recordingRef.current || !analyserRef.current) return;
        const rms = computeRms();
        levelRef.current = rms;
        const now = performance.now();
        const elapsed = now - startedAtRef.current;
        const speaking = elapsed > opts.warmupMs && rms >= opts.speechThreshold;

        if (speaking) {
          if (!speechStartedRef.current) speechStartedAtRef.current = now;
          speechStartedRef.current = true;
          lastVoiceAtRef.current = now;
        }

        if (mountedRef.current) {
          dispatch({
            type: 'level',
            level: rms,
            speaking,
            speechStarted: speechStartedRef.current,
          });
        }

        if (opts.autoStopOnSilence) {
          const heardEnough =
            speechStartedRef.current && now - speechStartedAtRef.current >= opts.minSpeechMs;
          const paused =
            speechStartedRef.current && now - lastVoiceAtRef.current >= opts.silenceMs;
          if (heardEnough && paused) {
            doStop('silence');
            return;
          }
        }

        if (
          !speechStartedRef.current &&
          opts.idleTimeoutMs &&
          elapsed >= opts.idleTimeoutMs
        ) {
          // Idle: drop the (silent) capture entirely.
          stopReasonRef.current = 'idle';
          skipDispatchRef.current = true;
          doStop('idle');
          return;
        }

        frameRef.current = requestAnimationFrame(tick);
      };

      frameRef.current = requestAnimationFrame(tick);
    },
    [computeRms, doStop],
  );

  const start = useCallback(
    async (startOpts: RecorderStartOptions = {}): Promise<RecorderStartHandle> => {
      if (recordingRef.current) {
        // Already recording — refuse to start a second session.
        return { finished: Promise.reject(new Error('Recorder is already recording.')) };
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        // `navigator.mediaDevices` is undefined in two very different situations:
        // a genuinely ancient browser, or — far more commonly — a page served over
        // plain HTTP from a non-loopback origin. Browsers only expose microphone
        // capture in a secure context (HTTPS, or localhost/127.0.0.1, which are
        // exempt). Blaming the browser in the second case sends people hunting for
        // the wrong problem, so name the real cause.
        const insecure = typeof window !== 'undefined' && !window.isSecureContext;
        const err = new Error(
          insecure
            ? `Microphone capture needs a secure origin. This page is served over ` +
              `${window.location.protocol}//${window.location.host}, and browsers only allow ` +
              `the microphone on HTTPS or on localhost. Reopen this page over HTTPS ` +
              `(run the server with HTTPS=1) or via an SSH tunnel to localhost.`
            : 'This browser does not support microphone capture.',
        );
        if (mountedRef.current) dispatch({ type: 'error', error: err });
        return { finished: Promise.reject(err) };
      }

      const opts: Required<RecorderStartOptions> = { ...DEFAULT_OPTS, ...startOpts };
      // Live preset implies silence auto-stop unless explicitly overridden.
      if (opts.mode === 'live' && startOpts.autoStopOnSilence === undefined) {
        opts.autoStopOnSilence = true;
      }

      // Reset per-session state.
      stopReasonRef.current = 'manual';
      skipDispatchRef.current = false;
      speechStartedRef.current = false;
      speechStartedAtRef.current = 0;
      lastVoiceAtRef.current = 0;
      levelRef.current = 0;

      if (mountedRef.current) dispatch({ type: 'requesting' });

      let finishedResolve!: (result: RecorderResult) => void;
      let finishedReject!: (err: Error) => void;
      const finished = new Promise<RecorderResult>((res, rej) => {
        finishedResolve = res;
        finishedReject = rej;
      });
      const session: Session = {
        resolve: finishedResolve,
        reject: finishedReject,
        opts,
        settled: false,
      };
      sessionRef.current = session;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const mimeType = MediaRecorder.isTypeSupported(MIME_PREFERRED)
          ? MIME_PREFERRED
          : MIME_FALLBACK;
        const recorder = new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;
        chunksRef.current = [];

        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          const type = recorderRef.current?.mimeType || MIME_FALLBACK;
          const blob = new Blob(chunksRef.current, { type });
          const durationMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
          const reason = stopReasonRef.current;
          const speechStarted = speechStartedRef.current;
          const skip = skipDispatchRef.current;
          chunksRef.current = [];
          cleanup();
          if (mountedRef.current) dispatch({ type: 'finished' });
          if (!session.settled) {
            session.settled = true;
            if (skip) {
              // cancel / idle: drop the blob (no result), resolve with reason so
              // session-model callers can distinguish; reject for cancel.
              if (reason === 'cancel') {
                session.reject(new Error('Recording cancelled'));
              } else {
                session.resolve({ blob, durationMs, mode: opts.mode, reason, speechStarted });
              }
            } else {
              session.resolve({ blob, durationMs, mode: opts.mode, reason, speechStarted });
            }
          }
          if (sessionRef.current === session) sessionRef.current = null;
        };

        startedAtRef.current = performance.now();
        recordingRef.current = true;
        startMonitor(opts);
        recorder.start(250);
        if (mountedRef.current) dispatch({ type: 'recording' });
      } catch (err) {
        cleanup();
        const error =
          err instanceof Error ? err : new Error('Could not access the microphone.');
        if (mountedRef.current) dispatch({ type: 'error', error });
        if (!session.settled) {
          session.settled = true;
          session.reject(error);
        }
        if (sessionRef.current === session) sessionRef.current = null;
        return { finished };
      }

      return { finished };
    },
    [cleanup, startMonitor],
  );

  const stop = useCallback(
    (reason: StopReason = 'manual') => {
      doStop(reason);
    },
    [doStop],
  );

  const cancel = useCallback(() => {
    skipDispatchRef.current = true;
    stopReasonRef.current = 'cancel';
    chunksRef.current = [];
    const recorder = recorderRef.current;
    if (recorder && recordingRef.current && recorder.state !== 'inactive') {
      recorder.stop(); // onstop resolves/rejects the session
    } else {
      cleanup();
      const session = sessionRef.current;
      if (session && !session.settled) {
        session.settled = true;
        session.reject(new Error('Recording cancelled'));
      }
      sessionRef.current = null;
      if (mountedRef.current) dispatch({ type: 'finished' });
    }
  }, [cleanup]);

  const reset = useCallback(() => {
    dispatch({ type: 'reset' });
  }, []);

  // Cleanup on unmount: stop tracks, close AudioContext, cancel RAF.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.onstop = null;
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      const session = sessionRef.current;
      if (session && !session.settled) {
        session.settled = true;
        session.reject(new Error('Recorder unmounted'));
      }
      sessionRef.current = null;
      cleanup();
    };
  }, [cleanup]);

  return {
    state: state.state,
    level: state.level,
    speaking: state.speaking,
    speechStarted: state.speechStarted,
    error: state.error,
    levelRef,
    start,
    stop,
    cancel,
    reset,
  };
}
