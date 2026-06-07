// Shared fetch wrapper for the whole app. All calls are root-relative `/api/...`
// (dev proxy handles it; prod same origin). Supports JSON and FormData bodies and
// surfaces typed errors, including the studio's 409 `revision_conflict`.

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

export interface RequestInitLike {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** GET (or any verb without a body) returning parsed JSON. */
export async function apiGet<T>(path: string, init: RequestInitLike = {}): Promise<T> {
  const res = await fetch(path, { method: 'GET', signal: init.signal, headers: init.headers });
  return handle<T>(res);
}

/** JSON-body request (POST/PATCH/etc). */
export async function apiJson<T>(
  path: string,
  method: string,
  body?: unknown,
  init: RequestInitLike = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: init.signal,
  });
  return handle<T>(res);
}

/** FormData (multipart) request — do NOT set Content-Type (browser adds boundary). */
export async function apiForm<T>(
  path: string,
  method: string,
  form: FormData,
  init: RequestInitLike = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    body: form,
    signal: init.signal,
    headers: init.headers,
  });
  return handle<T>(res);
}

/** DELETE returning nothing (204) or a small JSON body. */
export async function apiDelete<T>(path: string, init: RequestInitLike = {}): Promise<T> {
  const res = await fetch(path, { method: 'DELETE', signal: init.signal, headers: init.headers });
  return handle<T>(res);
}
