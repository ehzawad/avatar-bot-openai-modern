// Thin React bridge over the imperative AvatarRuntime (WEB_CONTRACT §7).
//
// Rules:
//   - The init effect depends ONLY on the container ref; it is StrictMode-idempotent
//     (guarded by runtimeRef.current) with symmetrical teardown.
//   - emotion / modelUrl are durable inputs applied via their own effects.
//   - gestureEvent is an EVENT, so its effect is keyed on the event id (fires once
//     per distinct gesture, even if the same Gesture type repeats).
//   - getMouthLevel is read INSIDE the RAF loop (via a latest-ref) — never React
//     state per frame.

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import type { Emotion, Gesture } from '../../../lib/api/types';
import { useLatest } from '../../../lib/hooks/useLatest';
import { AvatarRuntime } from './AvatarRuntime';

export interface GestureEvent {
  id: string;
  type: Gesture;
}

export interface UseAvatarSceneArgs {
  getMouthLevel: () => number;
  emotion: Emotion | null;
  gestureEvent: GestureEvent | null;
  modelUrl: string | null;
}

export interface UseAvatarSceneResult {
  loadUploadedFile: (file: File) => Promise<void>;
  resetToFallback: () => void;
}

export function useAvatarScene(
  containerRef: RefObject<HTMLElement | null>,
  { getMouthLevel, emotion, gestureEvent, modelUrl }: UseAvatarSceneArgs,
): UseAvatarSceneResult {
  const runtimeRef = useRef<AvatarRuntime | null>(null);
  // Keep mouth-level reader fresh without re-initialising the runtime.
  const mouthRef = useLatest(getMouthLevel);

  // --- init effect: depends ONLY on the container -------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (runtimeRef.current) return; // StrictMode-idempotent

    const runtime = new AvatarRuntime(container, {
      getMouthLevel: () => mouthRef.current(),
    });
    runtimeRef.current = runtime;
    runtime.init();

    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
    // containerRef is stable; mouthRef is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- durable: emotion ----------------------------------------------------
  useEffect(() => {
    if (emotion == null) return;
    runtimeRef.current?.setEmotion(emotion);
  }, [emotion]);

  // --- durable: modelUrl (null => fallback) --------------------------------
  // init() already installs the fallback, so the very first null pass is a no-op;
  // a later transition back to null does reset to fallback.
  const modelInitializedRef = useRef(false);
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (modelUrl == null) {
      if (modelInitializedRef.current) runtime.useGeneratedAvatar();
      modelInitializedRef.current = true;
      return;
    }
    modelInitializedRef.current = true;
    let cancelled = false;
    runtime.loadModel(modelUrl).catch(() => {
      if (!cancelled) runtime.useGeneratedAvatar();
    });
    return () => {
      cancelled = true;
    };
  }, [modelUrl]);

  // --- event: gesture (keyed on id) ----------------------------------------
  useEffect(() => {
    if (!gestureEvent) return;
    runtimeRef.current?.applyGesture(gestureEvent.type);
    // Keyed on id so repeated identical gestures still fire once each.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gestureEvent?.id]);

  const loadUploadedFile = useCallback(async (file: File): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error('Avatar runtime is not ready.');
    await runtime.loadUploadedFile(file);
  }, []);

  const resetToFallback = useCallback((): void => {
    runtimeRef.current?.useGeneratedAvatar();
  }, []);

  return { loadUploadedFile, resetToFallback };
}
