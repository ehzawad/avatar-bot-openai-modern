import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tier } from './api/types';
import {
  useCreateDataset,
  useCapture,
  useDataset,
  useDatasets,
  useDeleteDataset,
  useRenameDataset,
} from './api/queries';
import { useRecorder } from './features/recording/useRecorder';
import {
  newSegmentId,
  usePendingStore,
  type PendingCapture,
} from './features/recording/pendingStore';
import { clearDraftHistory, useDraftStore } from './features/editor/draftStore';
import { RecordBar } from './components/RecordBar';
import { FileCardFeed } from './components/FileCardFeed';
import { LineEditor } from './components/LineEditor';
import { RollbackTimeline } from './components/RollbackTimeline';
import { PendingQueue } from './components/PendingQueue';

const TIER_KEY = 'studio.tier';
const LANG_KEY = 'studio.language';

function loadTier(): Tier {
  const v = localStorage.getItem(TIER_KEY);
  if (v === 'fast' || v === 'best' || v === 'whisper') return v;
  return 'best'; // default tier per contract
}

function loadLang(): string {
  return localStorage.getItem(LANG_KEY) ?? 'bn';
}

interface Toast {
  id: number;
  message: string;
}

export function App() {
  const datasetsQuery = useDatasets();
  const cards = useMemo(() => datasetsQuery.data ?? [], [datasetsQuery.data]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const detailQuery = useDataset(activeId);
  const detail = detailQuery.data ?? null;

  const [tier, setTier] = useState<Tier>(() => loadTier());
  const [language, setLanguage] = useState<string>(() => loadLang());
  const autoRoll = true;

  const [highlightLineId, setHighlightLineId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const recorder = useRecorder();
  const pending = usePendingStore();

  const capture = useCapture();
  const createDataset = useCreateDataset();
  const renameDataset = useRenameDataset();
  const deleteDataset = useDeleteDataset();

  const beginDraft = useDraftStore((s) => s.begin);

  // Generated at record start; consumed when the recording finishes.
  const segmentIdRef = useRef<string | null>(null);

  const pushToast = useCallback((message: string) => {
    const id = (toastSeq.current += 1);
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    localStorage.setItem(TIER_KEY, tier);
  }, [tier]);
  useEffect(() => {
    localStorage.setItem(LANG_KEY, language);
  }, [language]);

  // Pick a sensible default active page once datasets load.
  useEffect(() => {
    if (activeId) return;
    if (cards.length === 0) return;
    const firstActive = cards.find((c) => c.status === 'active') ?? cards[0];
    setActiveId(firstActive.id);
  }, [cards, activeId]);

  const activeCard = useMemo(
    () => cards.find((c) => c.id === activeId) ?? null,
    [cards, activeId],
  );

  // Core capture submit — shared by initial submit and retries.
  const submitCapture = useCallback(
    (item: PendingCapture) => {
      pending.markUploading(item.client_segment_id);
      capture.mutate(
        {
          datasetId: item.datasetId,
          audio: item.blob,
          client_segment_id: item.client_segment_id,
          tier: item.tier,
          language: item.language,
          role: item.role,
          eval_part: item.eval_part,
          duration_ms: item.durationMs,
          auto_roll: true,
        },
        {
          onSuccess: (result) => {
            // Server confirmed append — now it is safe to drop the blob.
            pending.remove(item.client_segment_id);
            clearDraftHistory();
            setHighlightLineId(result.line.id);
            window.setTimeout(() => {
              setHighlightLineId((cur) => (cur === result.line.id ? null : cur));
            }, 2500);
            if (result.rolled) {
              setActiveId(result.dataset_id);
              pushToast(`Page ${String(result.dataset.page_no).padStart(3, '0')} created`);
            } else {
              setActiveId(result.dataset_id);
            }
          },
          onError: (err) => {
            pending.markFailed(item.client_segment_id, err.message);
            pushToast(`Capture failed: ${err.message}`);
          },
        },
      );
    },
    [capture, pending, pushToast],
  );

  // When a recording finishes, build a pending row and submit.
  useEffect(() => {
    if (recorder.state !== 'idle' || !recorder.blob) return;
    const blob = recorder.blob;
    const segId = segmentIdRef.current ?? newSegmentId();
    segmentIdRef.current = null;
    if (!activeId) {
      recorder.reset();
      pushToast('Select or create a page before recording.');
      return;
    }
    const item: PendingCapture = {
      client_segment_id: segId,
      datasetId: activeId,
      blob,
      durationMs: recorder.durationMs,
      tier,
      language,
      role: 'user',
      eval_part: 'ignored',
      status: 'uploading',
      error: null,
      createdAt: Date.now(),
    };
    pending.enqueue(item);
    recorder.reset();
    submitCapture(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.state, recorder.blob]);

  const onToggleRecord = useCallback(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
    } else if (recorder.state === 'idle') {
      if (!activeId) {
        pushToast('Select or create a page first.');
        return;
      }
      segmentIdRef.current = newSegmentId(); // generated at record start
      void recorder.start();
    }
  }, [recorder, activeId, pushToast]);

  const onCreate = useCallback(() => {
    const title = window.prompt('New series title', 'Bengali Eval');
    if (title === null) return;
    createDataset.mutate(
      { title: title.trim() || undefined, language },
      {
        onSuccess: ({ dataset }) => {
          setActiveId(dataset.id);
          pushToast(`Created "${dataset.name}"`);
        },
      },
    );
  }, [createDataset, language, pushToast]);

  const onRename = useCallback(
    (datasetId: string, name: string) => {
      const card = cards.find((c) => c.id === datasetId);
      renameDataset.mutate({
        datasetId,
        body: { name, base_revision_id: card?.current_revision_id ?? undefined },
      });
    },
    [cards, renameDataset],
  );

  const onDelete = useCallback(
    (datasetId: string) => {
      deleteDataset.mutate(
        { datasetId },
        {
          onSuccess: () => {
            if (activeId === datasetId) setActiveId(null);
            pushToast('Page deleted');
          },
        },
      );
    },
    [deleteDataset, activeId, pushToast],
  );

  // Download with unreviewed warning.
  const onDownloadGuard = useCallback(() => {
    if (!detail) return;
    const unreviewed = detail.lines.filter((l) => l.review_status === 'unreviewed').length;
    if (unreviewed > 0) {
      const accepted = window.confirm(
        `${unreviewed} line(s) are still unreviewed.\n\nOK = download accepted only.\nCancel = download all.`,
      );
      const url = accepted
        ? `/api/datasets/${detail.id}/download?format=jsonl&scope=accepted`
        : `/api/datasets/${detail.id}/download?format=jsonl&scope=all`;
      window.open(url, '_blank');
    } else {
      window.open(`/api/datasets/${detail.id}/download?format=jsonl&scope=accepted`, '_blank');
    }
  }, [detail]);

  // Pending queue actions.
  const onRetrySame = useCallback((item: PendingCapture) => submitCapture(item), [submitCapture]);
  const onRetryBest = useCallback(
    (item: PendingCapture) => submitCapture({ ...item, tier: 'best' }),
    [submitCapture],
  );
  const onDiscard = useCallback(
    (item: PendingCapture) => pending.remove(item.client_segment_id),
    [pending],
  );
  const onEditPending = useCallback(
    (item: PendingCapture) => {
      // No transcript yet; open a manual draft so the user can type what was said,
      // then discard the failed audio capture.
      setActiveId(item.datasetId);
      beginDraft({ lineId: `pending:${item.client_segment_id}`, text: '', role: item.role, eval_part: item.eval_part });
      pending.remove(item.client_segment_id);
      pushToast('Edit the line manually, then add it.');
    },
    [beginDraft, pending, pushToast],
  );

  const pendingItems = pending.items;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <h1>Bengali Eval Studio</h1>
          <span className="muted">Voice-first conversational dataset builder</span>
        </div>
        <a className="btn" href="/" title="Back to avatar app">
          ← Avatar app
        </a>
      </header>

      <RecordBar
        target={activeCard}
        recorderState={recorder.state}
        level={recorder.level}
        recorderError={recorder.error}
        tier={tier}
        language={language}
        autoRoll={autoRoll}
        onTierChange={setTier}
        onLanguageChange={setLanguage}
        onToggleRecord={onToggleRecord}
      />

      <PendingQueue
        items={pendingItems}
        onRetrySame={onRetrySame}
        onRetryBest={onRetryBest}
        onEdit={onEditPending}
        onDiscard={onDiscard}
      />

      <main className="app-main">
        <div className="app-col app-col--left">
          <FileCardFeed
            cards={cards}
            activeId={activeId}
            loading={datasetsQuery.isLoading}
            error={datasetsQuery.error ? datasetsQuery.error.message : null}
            onOpen={setActiveId}
            onRename={onRename}
            onDelete={onDelete}
            onCreate={onCreate}
            creating={createDataset.isPending}
            renamingId={renameDataset.isPending ? renameDataset.variables?.datasetId ?? null : null}
            deletingId={deleteDataset.isPending ? deleteDataset.variables?.datasetId ?? null : null}
          />
        </div>

        <div className="app-col app-col--center">
          {detailQuery.isLoading && activeId ? <p className="muted">Loading page…</p> : null}
          {detailQuery.error ? (
            <p className="error-text">{detailQuery.error.message}</p>
          ) : null}
          {detail ? (
            <>
              <div className="editor-toolbar">
                <a
                  className="btn btn--sm"
                  href={`/api/datasets/${detail.id}/download?format=txt&annotated=false`}
                  download
                >
                  Download .txt
                </a>
                <button type="button" className="btn btn--sm" onClick={onDownloadGuard}>
                  Download .jsonl
                </button>
              </div>
              <LineEditor dataset={detail} highlightLineId={highlightLineId} />
            </>
          ) : (
            !detailQuery.isLoading && <p className="muted">Select a page to edit its lines.</p>
          )}
        </div>

        <div className="app-col app-col--right">
          {activeId ? (
            <RollbackTimeline
              datasetId={activeId}
              currentRevisionId={activeCard?.current_revision_id ?? null}
            />
          ) : null}
        </div>
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
