// TanStack Query hooks + query keys (STUDIO_CONTRACT.md section 5).
//
// Query keys:
//   ['datasets']
//   ['dataset', id]
//   ['dataset', id, 'revisions']
//
// Invalidation rules (from the council):
//   append / edit / delete / reorder -> invalidate ['dataset', id] and
//        ['dataset', id, 'revisions']; append (and create/rename/delete dataset)
//        also invalidate ['datasets'].
//   rollback -> invalidate ALL keys for the id (['dataset', id], its revisions)
//        plus ['datasets'].

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import * as api from './client';
import type {
  AddLineBody,
  CaptureParams,
  CreateDatasetBody,
  DeleteLineResult,
  EditLineBody,
  EditLineResult,
  RenameDatasetBody,
  ReorderBody,
  ReorderResult,
} from './client';
import type { AppendResult, DatasetCard, DatasetDetail, Revision } from './types';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const queryKeys = {
  datasets: () => ['datasets'] as const,
  dataset: (id: string) => ['dataset', id] as const,
  revisions: (id: string) => ['dataset', id, 'revisions'] as const,
};

function invalidateAfterMutation(
  qc: QueryClient,
  id: string,
  opts: { datasets?: boolean } = {},
): void {
  void qc.invalidateQueries({ queryKey: queryKeys.dataset(id) });
  void qc.invalidateQueries({ queryKey: queryKeys.revisions(id) });
  if (opts.datasets) {
    void qc.invalidateQueries({ queryKey: queryKeys.datasets() });
  }
}

function invalidateAllForDataset(qc: QueryClient, id: string): void {
  // ['dataset', id] is the prefix of ['dataset', id, 'revisions'], so a single
  // prefix invalidation covers detail + revisions; datasets list also refreshed.
  void qc.invalidateQueries({ queryKey: queryKeys.dataset(id) });
  void qc.invalidateQueries({ queryKey: queryKeys.datasets() });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useDatasets() {
  return useQuery<{ datasets: DatasetCard[] }, Error, DatasetCard[]>({
    queryKey: queryKeys.datasets(),
    queryFn: () => api.listDatasets(),
    select: (data) => data.datasets,
  });
}

export function useDataset(datasetId: string | null | undefined) {
  return useQuery<DatasetDetail, Error>({
    queryKey: queryKeys.dataset(datasetId ?? '__none__'),
    queryFn: () => api.getDataset(datasetId as string),
    enabled: Boolean(datasetId),
  });
}

export function useRevisions(datasetId: string | null | undefined) {
  return useQuery<{ revisions: Revision[] }, Error, Revision[]>({
    queryKey: queryKeys.revisions(datasetId ?? '__none__'),
    queryFn: () => api.listRevisions(datasetId as string),
    enabled: Boolean(datasetId),
    select: (data) => data.revisions,
  });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export function useCapture() {
  const qc = useQueryClient();
  return useMutation<AppendResult, Error, CaptureParams>({
    mutationFn: (params) => api.capture(params),
    onSuccess: (result, params) => {
      // append: invalidate detail + revisions for both requested & written
      // datasets (auto-roll may write a different page), plus datasets list.
      invalidateAfterMutation(qc, params.datasetId, { datasets: true });
      if (result.dataset_id !== params.datasetId) {
        invalidateAfterMutation(qc, result.dataset_id, { datasets: true });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export function useAddLine() {
  const qc = useQueryClient();
  return useMutation<AppendResult, Error, { datasetId: string; body: AddLineBody }>({
    mutationFn: ({ datasetId, body }) => api.addLine(datasetId, body),
    onSuccess: (result, { datasetId }) => {
      invalidateAfterMutation(qc, datasetId, { datasets: true });
      if (result.dataset_id !== datasetId) {
        invalidateAfterMutation(qc, result.dataset_id, { datasets: true });
      }
    },
  });
}

export function useEditLine() {
  const qc = useQueryClient();
  return useMutation<
    EditLineResult,
    Error,
    { datasetId: string; lineId: string; body: EditLineBody }
  >({
    mutationFn: ({ datasetId, lineId, body }) => api.editLine(datasetId, lineId, body),
    onSuccess: (_result, { datasetId }) => {
      invalidateAfterMutation(qc, datasetId);
    },
  });
}

export function useDeleteLine() {
  const qc = useQueryClient();
  return useMutation<
    DeleteLineResult,
    Error,
    { datasetId: string; lineId: string; baseRevisionId?: number }
  >({
    mutationFn: ({ datasetId, lineId, baseRevisionId }) =>
      api.deleteLine(datasetId, lineId, baseRevisionId),
    onSuccess: (_result, { datasetId }) => {
      // delete changes the card's line_count, so refresh the feed too
      invalidateAfterMutation(qc, datasetId, { datasets: true });
    },
  });
}

export function useReorder() {
  const qc = useQueryClient();
  return useMutation<ReorderResult, Error, { datasetId: string; body: ReorderBody }>({
    mutationFn: ({ datasetId, body }) => api.reorder(datasetId, body),
    onSuccess: (_result, { datasetId }) => {
      invalidateAfterMutation(qc, datasetId);
    },
  });
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export function useRollback() {
  const qc = useQueryClient();
  return useMutation<
    DatasetDetail,
    Error,
    { datasetId: string; targetRevisionId: number }
  >({
    mutationFn: ({ datasetId, targetRevisionId }) =>
      api.rollback(datasetId, targetRevisionId),
    onSuccess: (_result, { datasetId }) => {
      invalidateAllForDataset(qc, datasetId);
    },
  });
}

// ---------------------------------------------------------------------------
// Dataset lifecycle
// ---------------------------------------------------------------------------

export function useCreateDataset() {
  const qc = useQueryClient();
  return useMutation<{ dataset: DatasetCard }, Error, CreateDatasetBody>({
    mutationFn: (body) => api.createDataset(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.datasets() });
    },
  });
}

export function useRenameDataset() {
  const qc = useQueryClient();
  return useMutation<
    { dataset: DatasetCard },
    Error,
    { datasetId: string; body: RenameDatasetBody }
  >({
    mutationFn: ({ datasetId, body }) => api.renameDataset(datasetId, body),
    onSuccess: (_result, { datasetId }) => {
      invalidateAfterMutation(qc, datasetId, { datasets: true });
    },
  });
}

export function useDeleteDataset() {
  const qc = useQueryClient();
  return useMutation<void, Error, { datasetId: string }>({
    mutationFn: ({ datasetId }) => api.deleteDataset(datasetId),
    onSuccess: (_result, { datasetId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.datasets() });
      void qc.removeQueries({ queryKey: queryKeys.dataset(datasetId) });
    },
  });
}
