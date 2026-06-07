// Zustand + zundo store for UNSAVED line-edit drafts only.
//
// Durable history lives on the server (revisions endpoint). This temporal
// history is purely local: it tracks the in-progress edit so the user can
// undo/redo keystrokes before saving. After a successful append/save/rollback
// the caller MUST call clear() to drop the temporal history.

import { create } from 'zustand';
import { temporal } from 'zundo';
import type { TemporalState } from 'zundo';
import { useStore } from 'zustand';
import type { EvalPart, Role } from '../../api/types';

export interface LineDraft {
  lineId: string;
  text: string;
  role: Role;
  eval_part: EvalPart;
}

interface DraftState {
  // The only field tracked by zundo (via partialize) is `draft`.
  draft: LineDraft | null;

  // Actions (not tracked by temporal).
  begin: (draft: LineDraft) => void;
  setText: (text: string) => void;
  setRole: (role: Role) => void;
  setEvalPart: (evalPart: EvalPart) => void;
  cancel: () => void;
  commit: () => LineDraft | null;
}

export const useDraftStore = create<DraftState>()(
  temporal(
    (set, get) => ({
      draft: null,

      begin: (draft) => set({ draft }),

      setText: (text) =>
        set((s) => (s.draft ? { draft: { ...s.draft, text } } : s)),

      setRole: (role) =>
        set((s) => (s.draft ? { draft: { ...s.draft, role } } : s)),

      setEvalPart: (eval_part) =>
        set((s) => (s.draft ? { draft: { ...s.draft, eval_part } } : s)),

      cancel: () => set({ draft: null }),

      commit: () => {
        const current = get().draft;
        set({ draft: null });
        return current;
      },
    }),
    {
      limit: 50,
      // Only the unsaved draft participates in undo/redo history.
      partialize: (state) => ({ draft: state.draft }),
    },
  ),
);

// Typed access to the temporal store.
export const useTemporalDraftStore = <T>(
  selector: (state: TemporalState<{ draft: LineDraft | null }>) => T,
): T => useStore(useDraftStore.temporal, selector);

// Imperative helpers (usable outside React render).
export const draftTemporal = useDraftStore.temporal;

export function undoDraft(): void {
  draftTemporal.getState().undo();
}

export function redoDraft(): void {
  draftTemporal.getState().redo();
}

export function clearDraftHistory(): void {
  draftTemporal.getState().clear();
}
