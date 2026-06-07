// Holds in-flight / failed captures. The audio blob is retained here until the
// server confirms the append (contract section 5: "Never discard the audio blob
// until the server confirms append.").

import { create } from 'zustand';
import type { EvalPart, Role, Tier } from '../../api/types';

export type PendingStatus = 'uploading' | 'failed';

export interface PendingCapture {
  client_segment_id: string;
  datasetId: string;
  blob: Blob;
  durationMs: number;
  tier: Tier;
  language: string;
  role: Role;
  eval_part: EvalPart;
  status: PendingStatus;
  error: string | null;
  createdAt: number;
}

interface PendingState {
  items: PendingCapture[];
  enqueue: (item: PendingCapture) => void;
  markFailed: (clientSegmentId: string, error: string) => void;
  markUploading: (clientSegmentId: string) => void;
  update: (clientSegmentId: string, patch: Partial<PendingCapture>) => void;
  remove: (clientSegmentId: string) => void;
}

export const usePendingStore = create<PendingState>((set) => ({
  items: [],

  enqueue: (item) =>
    set((s) => ({
      items: [...s.items.filter((i) => i.client_segment_id !== item.client_segment_id), item],
    })),

  markFailed: (clientSegmentId, error) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.client_segment_id === clientSegmentId ? { ...i, status: 'failed', error } : i,
      ),
    })),

  markUploading: (clientSegmentId) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.client_segment_id === clientSegmentId
          ? { ...i, status: 'uploading', error: null }
          : i,
      ),
    })),

  update: (clientSegmentId, patch) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.client_segment_id === clientSegmentId ? { ...i, ...patch } : i,
      ),
    })),

  remove: (clientSegmentId) =>
    set((s) => ({
      items: s.items.filter((i) => i.client_segment_id !== clientSegmentId),
    })),
}));

export function newSegmentId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `seg_${crypto.randomUUID()}`;
  }
  return `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
