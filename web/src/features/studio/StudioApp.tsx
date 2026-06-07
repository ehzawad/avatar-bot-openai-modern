import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Tier } from '../../lib/api/types';
import {
  useCreateDataset,
  useCapture,
  useDataset,
  useDatasets,
  useDeleteDataset,
  useRenameDataset,
} from '../../lib/api/studioQueries';
import { useRecorder } from '../../lib/audio/useRecorder';
import { newSegmentId, usePendingStore, type PendingCapture } from './recording/pendingStore';
import { clearDraftHistory, useDraftStore } from './editor/draftStore';
import { RecordBar } from './components/RecordBar';
import { FileCardFeed } from './components/FileCardFeed';
import { LineEditor } from './components/LineEditor';
import { RollbackTimeline } from './components/RollbackTimeline';
import { PendingQueue } from './components/PendingQueue';
import './studio.css';

const TIER_KEY = 'studio.tier';
const LANG_KEY = 'studio.language';
const TAG_KEY = 'studio.tag';

function loadTier(): Tier {
  const v = localStorage.getItem(TIER_KEY);
  if (v === 'fast' || v === 'best' || v === 'diarize') return v;
  return 'best'; // default tier per contract
}

function loadLang(): string {
  return localStorage.getItem(LANG_KEY) ?? 'bn';
}

function loadTag(): string {
  return localStorage.getItem(TAG_KEY) ?? '';
}

interface Toast {
  id: number;
  message: string;
}

export function StudioApp() {
  const datasetsQuery = useDatasets();
  const cards = useMemo(() => datasetsQuery.data ?? [], [datasetsQuery.data]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const detailQuery = useDataset(activeId);
  const detail = detailQuery.data ?? null;

  const [tier, setTier] = useState<Tier>(() => loadTier());
  const [language, setLanguage] = useState<string>(() => loadLang());
  const [tag, setTag] = useState<string>(() => loadTag());
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

  // Latest values readable inside the async recording session callback.
  const tierRef = useRef(tier);
  const languageRef = useRef(language);
  const tagRef = useRef(tag);
  const activeIdRef = useRef(activeId);
  tierRef.current = tier;
  languageRef.current = language;
  tagRef.current = tag;
  activeIdRef.current = activeId;

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
  useEffect(() => {
    localStorage.setItem(TAG_KEY, tag);
  }, [tag]);

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
          tag: item.tag,
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

  // Manual capture loop using the shared recorder's start()->{finished} session model.
  const onToggleRecord = useCallback(() => {
    if (recorder.state === 'recording') {
      recorder.stop('manual');
      return;
    }
    if (recorder.state !== 'idle') return;
    const targetId = activeIdRef.current;
    if (!targetId) {
      pushToast('Select or create a page first.');
      return;
    }
    const segId = newSegmentId(); // generated at record start (idempotency key)
    void (async () => {
      let handle;
      try {
        handle = await recorder.start({ mode: 'manual' });
      } catch (err) {
        pushToast(err instanceof Error ? err.message : 'Could not start recording.');
        return;
      }
      let result;
      try {
        result = await handle.finished;
      } catch {
        // cancelled / unmounted — nothing to submit.
        return;
      }
      const datasetId = activeIdRef.current;
      if (!datasetId) {
        pushToast('Select or create a page before recording.');
        return;
      }
      const tagValue = tagRef.current.trim();
      const item: PendingCapture = {
        client_segment_id: segId,
        datasetId,
        blob: result.blob,
        durationMs: result.durationMs,
        tier: tierRef.current,
        language: languageRef.current,
        role: 'user',
        eval_part: 'ignored',
        tag: tagValue === '' ? null : tagValue,
        status: 'uploading',
        error: null,
        createdAt: Date.now(),
      };
      pending.enqueue(item);
      submitCapture(item);
    })();
  }, [recorder, pending, submitCapture, pushToast]);

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
      beginDraft({
        lineId: `pending:${item.client_segment_id}`,
        text: '',
        role: item.role,
        eval_part: item.eval_part,
      });
      pending.remove(item.client_segment_id);
      pushToast('Edit the line manually, then add it.');
    },
    [beginDraft, pending, pushToast],
  );

  const pendingItems = pending.items;

  return (
    <div className="studio-app">
      <div className="app">
        <header className="app-header">
          <div className="app-brand">
            <h1>Bengali Eval Studio</h1>
            <span className="muted">Voice-first conversational dataset builder</span>
          </div>
          <nav className="header-actions" aria-label="Workspace navigation">
            <Link className="btn" to="/">
              Home
            </Link>
            <Link className="btn" to="/avatar" title="Open Aria">
              Aria
            </Link>
          </nav>
        </header>

        <RecordBar
          target={activeCard}
          recorderState={recorder.state}
          level={recorder.level}
          recorderError={recorder.error ? recorder.error.message : null}
          tier={tier}
          language={language}
          autoRoll={autoRoll}
          tag={tag}
          onTierChange={setTier}
          onLanguageChange={setLanguage}
          onTagChange={setTag}
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
            {detailQuery.error ? <p className="error-text">{detailQuery.error.message}</p> : null}
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
                  <a
                    className="btn btn--sm"
                    href={`/api/datasets/${detail.id}/download?format=csv&scope=all`}
                    download
                  >
                    Download .csv
                  </a>
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
    </div>
  );
}

export default StudioApp;
