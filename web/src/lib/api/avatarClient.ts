// Typed fetch wrappers for the avatar/conversation endpoints (WEB_CONTRACT §4).
// All calls are root-relative `/api/...`. No Three imports here (lib stays clean).

import { apiForm, apiGet, apiJson } from './http';
import type {
  ChatResponse,
  CreateConversationResponse,
  HealthResponse,
  InteractionMode,
  PublicConfig,
  TranscriptionResponse,
} from './types';

export function health(signal?: AbortSignal): Promise<HealthResponse> {
  return apiGet<HealthResponse>('/api/health', { signal });
}

export function config(signal?: AbortSignal): Promise<PublicConfig> {
  return apiGet<PublicConfig>('/api/config', { signal });
}

export function createConversation(signal?: AbortSignal): Promise<CreateConversationResponse> {
  return apiJson<CreateConversationResponse>('/api/conversations', 'POST', {}, { signal });
}

export interface SendMessageParams {
  conversationId: string;
  message: string;
  voice: string;
  interactionMode?: InteractionMode;
  signal?: AbortSignal;
}

export function sendMessage(params: SendMessageParams): Promise<ChatResponse> {
  const { conversationId, message, voice, interactionMode = 'chat', signal } = params;
  return apiJson<ChatResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    'POST',
    { message, voice, interaction_mode: interactionMode },
    { signal },
  );
}

export interface TranscribeParams {
  audio: Blob;
  filename?: string;
  signal?: AbortSignal;
}

export function transcribe(params: TranscribeParams): Promise<TranscriptionResponse> {
  const { audio, filename = 'speech.webm', signal } = params;
  const form = new FormData();
  form.append('audio', audio, filename);
  return apiForm<TranscriptionResponse>('/api/speech/transcriptions', 'POST', form, { signal });
}
