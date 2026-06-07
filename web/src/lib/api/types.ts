// Shared TS types for the unified web app.
//
// Studio types mirror STUDIO_CONTRACT.md §4 (with the new `tag` field on Line,
// per WEB_CONTRACT §6). Avatar/conversation types mirror WEB_CONTRACT §4.

// ---------------------------------------------------------------------------
// Studio types (ported from studio-web/src/api/types.ts + tag delta)
// ---------------------------------------------------------------------------

export type Tier = 'fast' | 'best';
export type Role = 'user' | 'assistant' | 'interviewer' | 'system';
export type EvalPart = 'prompt' | 'context' | 'expected' | 'ignored';
export type ReviewStatus = 'unreviewed' | 'accepted' | 'rejected' | 'needs_review';

export interface DatasetCard {
  id: string;
  series_id: string;
  page_no: number;
  name: string;
  status: 'active' | 'full' | 'archived';
  line_count: number;
  page_size: number;
  current_revision_id: number | null;
  language: string;
  created_at: string;
  updated_at: string;
}

export interface Line {
  id: string;
  dataset_id: string;
  line_index: number;
  role: Role;
  eval_part: EvalPart;
  conversation_key: string | null;
  turn_index: number | null;
  text: string;
  raw_transcript: string | null;
  source: 'voice' | 'manual' | 'import';
  review_status: ReviewStatus;
  flags: string[];
  // WEB_CONTRACT §6: per-line optional, nullable tag.
  tag: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DatasetDetail extends DatasetCard {
  lines: Line[];
  revision_count: number;
}

export interface Revision {
  id: number;
  revision_no: number;
  op: string;
  summary: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface AppendResult {
  requested_dataset_id: string;
  dataset_id: string;
  rolled: boolean;
  line: Line;
  dataset: DatasetCard;
  revision_id: number;
}

// ---------------------------------------------------------------------------
// Avatar / conversation types (WEB_CONTRACT §4)
// ---------------------------------------------------------------------------

export type Emotion = 'neutral' | 'joy' | 'sorrow' | 'angry' | 'fun' | 'surprised';
export type Gesture = 'idle' | 'nod' | 'shake' | 'lean_in' | 'wave';
export type InteractionMode = 'chat' | 'live_interview';

export interface AvatarReply {
  text: string;
  emotion: Emotion;
  gesture: Gesture;
  listen_hint: string;
}

export interface AudioPayload {
  mime_type: string;
  format: string;
  data_url: string;
}

export interface ChatResponse {
  conversation_id: string;
  message_id: string;
  response_id: string | null;
  reply: AvatarReply;
  audio: AudioPayload;
  usage?: Record<string, unknown> | null;
}

export interface PublicConfig {
  response_model: string;
  tts_model: string;
  transcribe_model: string;
  default_voice: string;
  voices: string[];
  emotions: Emotion[];
  gestures: Gesture[];
  // studio fields (already added on the backend /api/config):
  transcribe_tiers: { id: string; label: string; model: string }[];
  stt_prompts: { id: string; label: string }[];
  languages: string[];
  dataset_page_size_default: number;
}

export interface HealthResponse {
  status: string;
  openai_configured: boolean;
  response_model: string;
  tts_model: string;
  transcribe_model: string;
}

export interface CreateConversationResponse {
  conversation_id: string;
  created_at: string;
}

export interface TranscriptionResponse {
  text: string;
}
