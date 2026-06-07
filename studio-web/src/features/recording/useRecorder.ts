// Reducer-based recording hook. Ports the MediaRecorder + RMS-level-meter logic
// from frontend/src/audio/recorder.js into React.
//
// States: idle | requesting_mic | recording | stopping
// Returns: { state, level, start(), stop(), blob, durationMs, error }

import { useCallback, useEffect, useReducer, useRef } from 'react';

export type RecorderState = 'idle' | 'requesting_mic' | 'recording' | 'stopping';

interface State {
  state: RecorderState;
  level: number; // RMS 0..1
  blob: Blob | null;
  durationMs: number;
  error: string | null;
}

type Action =
  | { type: 'requesting' }
  | { type: 'recording' }
  | { type: 'stopping' }
  | { type: 'level'; level: number }
  | { type: 'finished'; blob: Blob; durationMs: number }
  | { type: 'error'; error: string }
  | { type: 'reset' };

const INITIAL: State = {
  state: 'idle',
  level: 0,
  blob: null,
  durationMs: 0,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'requesting':
      return { ...INITIAL, state: 'requesting_mic' };
    case 'recording':
      return { ...state, state: 'recording', error: null };
    case 'stopping':
      return { ...state, state: 'stopping' };
    case 'level':
      return { ...state, level: action.level };
    case 'finished':
      return {
        ...state,
        state: 'idle',
        level: 0,
        blob: action.blob,
        durationMs: action.durationMs,
      };
    case 'error':
      return { ...state, state: 'idle', level: 0, error: action.error };
    case 'reset':
      return INITIAL;
    default:
      return state;
  }
}

export interface UseRecorderResult {
  state: RecorderState;
  level: number;
  blob: Blob | null;
  durationMs: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

const MIME_PREFERRED = 'audio/webm;codecs=opus';
const MIME_FALLBACK = 'audio/webm';

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
  const startedAtRef = useRef<number>(0);
  const recordingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);

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

  const startMonitor = useCallback(() => {
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
      if (mountedRef.current) dispatch({ type: 'level', level: rms });
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [computeRms]);

  const start = useCallback(async () => {
    if (recordingRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({ type: 'error', error: 'This browser does not support microphone capture.' });
      return;
    }
    dispatch({ type: 'requesting' });
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
        chunksRef.current = [];
        cleanup();
        if (mountedRef.current) dispatch({ type: 'finished', blob, durationMs });
      };

      startedAtRef.current = performance.now();
      recordingRef.current = true;
      startMonitor();
      recorder.start(250);
      dispatch({ type: 'recording' });
    } catch (err) {
      cleanup();
      const message =
        err instanceof Error ? err.message : 'Could not access the microphone.';
      dispatch({ type: 'error', error: message });
    }
  }, [cleanup, startMonitor]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recordingRef.current && recorder.state !== 'inactive') {
      dispatch({ type: 'stopping' });
      recorder.stop(); // triggers onstop -> 'finished'
    }
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'reset' });
  }, []);

  // Cleanup on unmount.
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
      cleanup();
    };
  }, [cleanup]);

  return {
    state: state.state,
    level: state.level,
    blob: state.blob,
    durationMs: state.durationMs,
    error: state.error,
    start,
    stop,
    reset,
  };
}
