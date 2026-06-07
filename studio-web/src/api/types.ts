// Mirrors STUDIO_CONTRACT.md section 4 exactly.

export type Tier = 'fast' | 'best' | 'whisper';
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
