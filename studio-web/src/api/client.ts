// Typed fetch wrappers for every endpoint in STUDIO_CONTRACT.md section 3.
// All calls are root-relative `/api/...` (dev proxy handles it; prod same origin).

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
// Error types
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export class ConflictError extends ApiError {
  readonly currentRevisionId: number | null;
  constructor(message: string, detail: unknown, currentRevisionId: number | null) {
    super(409, message, detail);
    this.name = 'ConflictError';
    this.currentRevisionId = currentRevisionId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractMessage(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail;
  if (isRecord(detail)) {
    const inner = detail.detail ?? detail;
    if (typeof inner === 'string') return inner;
    if (isRecord(inner) && typeof inner.message === 'string') return inner.message;
  }
  return fallback;
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await parseBody(res)) as T;
  }
  const body = await parseBody(res);
  const message = extractMessage(body, `${res.status} ${res.statusText}`);
  if (res.status === 409) {
    let currentRevisionId: number | null = null;
    if (isRecord(body)) {
      const d = isRecord(body.detail) ? body.detail : body;
      const crid = (d as Record<string, unknown>).current_revision_id;
      if (typeof crid === 'number') currentRevisionId = crid;
    }
    throw new ConflictError(message, body, currentRevisionId);
  }
  throw new ApiError(res.status, message, body);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

// ---------------------------------------------------------------------------
// Datasets / series
// ---------------------------------------------------------------------------

export async function listDatasets(): Promise<{ datasets: DatasetCard[] }> {
  const res = await fetch('/api/datasets');
  return handle<{ datasets: DatasetCard[] }>(res);
}

export async function getDataset(datasetId: string): Promise<DatasetDetail> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}`);
  return handle<DatasetDetail>(res);
}

export interface CreateDatasetBody {
  title?: string;
  page_size?: number;
  language?: string;
}

export async function createDataset(body: CreateDatasetBody): Promise<{ dataset: DatasetCard }> {
  const res = await fetch('/api/datasets', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return handle<{ dataset: DatasetCard }>(res);
}

export interface RenameDatasetBody {
  name?: string;
  base_revision_id?: number;
}

export async function renameDataset(
  datasetId: string,
  body: RenameDatasetBody,
): Promise<{ dataset: DatasetCard }> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return handle<{ dataset: DatasetCard }>(res);
}

export async function deleteDataset(datasetId: string): Promise<void> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}`, {
    method: 'DELETE',
  });
  return handle<void>(res);
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
  filename?: string;
}

export async function capture(params: CaptureParams): Promise<AppendResult> {
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

  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/capture`, {
    method: 'POST',
    body: form,
  });
  return handle<AppendResult>(res);
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
  base_revision_id?: number;
}

export async function addLine(datasetId: string, body: AddLineBody): Promise<AppendResult> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/lines`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return handle<AppendResult>(res);
}

export interface EditLineBody {
  text?: string;
  role?: Role;
  eval_part?: EvalPart;
  conversation_key?: string;
  turn_index?: number;
  review_status?: ReviewStatus;
  flags?: string[];
  base_revision_id?: number;
}

export interface EditLineResult {
  dataset: DatasetCard;
  line: Line;
  revision_id: number;
}

export async function editLine(
  datasetId: string,
  lineId: string,
  body: EditLineBody,
): Promise<EditLineResult> {
  const res = await fetch(
    `/api/datasets/${encodeURIComponent(datasetId)}/lines/${encodeURIComponent(lineId)}`,
    {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
  );
  return handle<EditLineResult>(res);
}

export interface DeleteLineResult {
  dataset: DatasetCard;
  revision_id: number;
}

export async function deleteLine(
  datasetId: string,
  lineId: string,
  baseRevisionId?: number,
): Promise<DeleteLineResult> {
  const qs =
    baseRevisionId !== undefined ? `?base_revision_id=${encodeURIComponent(baseRevisionId)}` : '';
  const res = await fetch(
    `/api/datasets/${encodeURIComponent(datasetId)}/lines/${encodeURIComponent(lineId)}${qs}`,
    { method: 'DELETE' },
  );
  return handle<DeleteLineResult>(res);
}

export interface ReorderBody {
  line_ids: string[];
  base_revision_id?: number;
}

export interface ReorderResult {
  dataset: DatasetCard;
  revision_id: number;
}

export async function reorder(datasetId: string, body: ReorderBody): Promise<ReorderResult> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/reorder`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return handle<ReorderResult>(res);
}

// ---------------------------------------------------------------------------
// Revisions / rollback
// ---------------------------------------------------------------------------

export async function listRevisions(datasetId: string): Promise<{ revisions: Revision[] }> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/revisions`);
  return handle<{ revisions: Revision[] }>(res);
}

export async function rollback(
  datasetId: string,
  targetRevisionId: number,
): Promise<DatasetDetail> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/rollback`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ target_revision_id: targetRevisionId }),
  });
  return handle<DatasetDetail>(res);
}

// ---------------------------------------------------------------------------
// Downloads (URL builders — opened directly so the browser downloads them)
// ---------------------------------------------------------------------------

export function downloadTxtUrl(
  datasetId: string,
  opts: { annotated?: boolean } = {},
): string {
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
