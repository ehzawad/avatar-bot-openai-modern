// TanStack mutation hooks for the avatar turn pipeline (WEB_CONTRACT §8 transport).
// NO Three imports — the chat state machine drives these via `mutateAsync`.

import { useMutation } from '@tanstack/react-query';

import * as api from './avatarClient';
import type {
  ChatResponse,
  CreateConversationResponse,
  TranscriptionResponse,
} from './types';

export function useCreateConversation() {
  return useMutation<CreateConversationResponse, Error, { signal?: AbortSignal } | void>({
    mutationFn: (vars) => api.createConversation(vars?.signal),
  });
}

export interface TranscribeVars {
  audio: Blob;
  filename?: string;
  signal?: AbortSignal;
}

export function useTranscribe() {
  return useMutation<TranscriptionResponse, Error, TranscribeVars>({
    mutationFn: (vars) => api.transcribe(vars),
  });
}

export type SendMessageVars = api.SendMessageParams;

export function useSendMessage() {
  return useMutation<ChatResponse, Error, SendMessageVars>({
    mutationFn: (vars) => api.sendMessage(vars),
  });
}
