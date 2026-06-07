// Typed fetch wrappers for the studio endpoints (STUDIO_CONTRACT §3 + WEB_CONTRACT
// §6 deltas: per-line `tag` and CSV export). All calls are root-relative `/api/...`.

import { apiDelete, apiForm, apiGet, apiJson } from './http';
import type {
  AppendResult,
  DatasetCard,
  DatasetDetail,
  EvalPart,
  Line,
  Revision,
  ReviewStatus,
  Role,
  Tier,
} from './types';

// ---------------------------------------------------------------------------
// Datasets / series
// ---------------------------------------------------------------------------

export function listDatasets(): Promise<{ datasets: DatasetCard[] }> {
  return apiGet<{ datasets: DatasetCard[] }>('/api/datasets');
}

export function getDataset(datasetId: string): Promise<DatasetDetail> {
  return apiGet<DatasetDetail>(`/api/datasets/${encodeURIComponent(datasetId)}`);
}

export interface CreateDatasetBody {
  title?: string;
  page_size?: number;
  language?: string;
}

export function createDataset(body: CreateDatasetBody): Promise<{ dataset: DatasetCard }> {
  return apiJson<{ dataset: DatasetCard }>('/api/datasets', 'POST', body);
}

export interface RenameDatasetBody {
  name?: string;
  base_revision_id?: number;
}

export function renameDataset(
  datasetId: string,
  body: RenameDatasetBody,
): Promise<{ dataset: DatasetCard }> {
  return apiJson<{ dataset: DatasetCard }>(
    `/api/datasets/${encodeURIComponent(datasetId)}`,
    'PATCH',
    body,
  );
}

export function deleteDataset(datasetId: string): Promise<void> {
  return apiDelete<void>(`/api/datasets/${encodeURIComponent(datasetId)}`);
}

// ---------------------------------------------------------------------------
// Capture (primary voice loop)
// ---------------------------------------------------------------------------

export interface CaptureParams {
  datasetId: string;
  audio: Blob;
  client_segment_id: string;
  tier?: Tier;
  language?: string;
  prompt_id?: string;
  auto_roll?: boolean;
  role?: Role;
  eval_part?: EvalPart;
  conversation_key?: string;
  turn_index?: number;
  duration_ms?: number;
  // WEB_CONTRACT §6: optional per-capture tag (empty/whitespace -> null on server).
  tag?: string | null;
  filename?: string;
}

export function capture(params: CaptureParams): Promise<AppendResult> {
  const {
    datasetId,
    audio,
    client_segment_id,
    tier = 'best',
    language = 'bn',
    prompt_id = 'bn-codeswitch-v1',
    auto_roll = true,
    role,
    eval_part,
    conversation_key,
    turn_index,
    duration_ms,
    tag,
    filename = 'capture.webm',
  } = params;

  const form = new FormData();
  form.append('audio', audio, filename);
  form.append('client_segment_id', client_segment_id);
  form.append('tier', tier);
  form.append('language', language);
  form.append('prompt_id', prompt_id);
  form.append('auto_roll', auto_roll ? 'true' : 'false');
  if (role !== undefined) form.append('role', role);
  if (eval_part !== undefined) form.append('eval_part', eval_part);
  if (conversation_key !== undefined) form.append('conversation_key', conversation_key);
  if (turn_index !== undefined) form.append('turn_index', String(turn_index));
  if (duration_ms !== undefined) form.append('duration_ms', String(duration_ms));
  // Send tag only when it has content; the server normalizes empty -> NULL.
  if (tag != null && tag.trim() !== '') form.append('tag', tag);

  return apiForm<AppendResult>(
    `/api/datasets/${encodeURIComponent(datasetId)}/capture`,
    'POST',
    form,
  );
}

// ---------------------------------------------------------------------------
// Lines (manual edits)
// ---------------------------------------------------------------------------

export interface AddLineBody {
  text: string;
  role?: Role;
  eval_part?: EvalPart;
  conversation_key?: string;
  turn_index?: number;
  tag?: string | null;
  base_revision_id?: number;
}

export function addLine(datasetId: string, body: AddLineBody): Promise<AppendResult> {
  return apiJson<AppendResult>(
    `/api/datasets/${encodeURIComponent(datasetId)}/lines`,
    'POST',
    body,
  );
}

export interface EditLineBody {
  text?: string;
  role?: Role;
  eval_part?: EvalPart;
  conversation_key?: string;
  turn_index?: number;
  review_status?: ReviewStatus;
  flags?: string[];
  // WEB_CONTRACT §6: PATCH a line's tag (empty/whitespace -> null on server).
  tag?: string | null;
  base_revision_id?: number;
}

export interface EditLineResult {
  dataset: DatasetCard;
  line: Line;
  revision_id: number;
}

export function editLine(
  datasetId: string,
  lineId: string,
  body: EditLineBody,
): Promise<EditLineResult> {
  return apiJson<EditLineResult>(
    `/api/datasets/${encodeURIComponent(datasetId)}/lines/${encodeURIComponent(lineId)}`,
    'PATCH',
    body,
  );
}

export interface DeleteLineResult {
  dataset: DatasetCard;
  revision_id: number;
}

export function deleteLine(
  datasetId: string,
  lineId: string,
  baseRevisionId?: number,
): Promise<DeleteLineResult> {
  const qs =
    baseRevisionId !== undefined ? `?base_revision_id=${encodeURIComponent(baseRevisionId)}` : '';
  return apiDelete<DeleteLineResult>(
    `/api/datasets/${encodeURIComponent(datasetId)}/lines/${encodeURIComponent(lineId)}${qs}`,
  );
}

export interface ReorderBody {
  line_ids: string[];
  base_revision_id?: number;
}

export interface ReorderResult {
  dataset: DatasetCard;
  revision_id: number;
}

export function reorder(datasetId: string, body: ReorderBody): Promise<ReorderResult> {
  return apiJson<ReorderResult>(
    `/api/datasets/${encodeURIComponent(datasetId)}/reorder`,
    'PATCH',
    body,
  );
}

// ---------------------------------------------------------------------------
// Revisions / rollback
// ---------------------------------------------------------------------------

export function listRevisions(datasetId: string): Promise<{ revisions: Revision[] }> {
  return apiGet<{ revisions: Revision[] }>(
    `/api/datasets/${encodeURIComponent(datasetId)}/revisions`,
  );
}

export function rollback(datasetId: string, targetRevisionId: number): Promise<DatasetDetail> {
  return apiJson<DatasetDetail>(
    `/api/datasets/${encodeURIComponent(datasetId)}/rollback`,
    'POST',
    { target_revision_id: targetRevisionId },
  );
}

// ---------------------------------------------------------------------------
// Downloads (URL builders — opened directly so the browser downloads them)
// ---------------------------------------------------------------------------

export function downloadTxtUrl(datasetId: string, opts: { annotated?: boolean } = {}): string {
  const params = new URLSearchParams({ format: 'txt' });
  params.set('annotated', opts.annotated ? 'true' : 'false');
  return `/api/datasets/${encodeURIComponent(datasetId)}/download?${params.toString()}`;
}

export function downloadJsonlUrl(
  datasetId: string,
  opts: { scope?: 'accepted' | 'all' } = {},
): string {
  const params = new URLSearchParams({ format: 'jsonl' });
  params.set('scope', opts.scope ?? 'accepted');
  return `/api/datasets/${encodeURIComponent(datasetId)}/download?${params.toString()}`;
}

// WEB_CONTRACT §6: CSV export (text,tagname; RFC-4180 quoting handled server-side).
export function downloadCsvUrl(
  datasetId: string,
  opts: { scope?: 'accepted' | 'all' } = {},
): string {
  const params = new URLSearchParams({ format: 'csv' });
  params.set('scope', opts.scope ?? 'all');
  return `/api/datasets/${encodeURIComponent(datasetId)}/download?${params.toString()}`;
}
