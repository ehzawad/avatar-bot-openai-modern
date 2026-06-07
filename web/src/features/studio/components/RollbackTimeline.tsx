import type { Revision } from '../../../lib/api/types';
import { useRevisions, useRollback } from '../../../lib/api/studioQueries';

interface Props {
  datasetId: string;
  currentRevisionId: number | null;
}

// A "deep" rollback is one that skips more than this many revisions back.
const DEEP_ROLLBACK_THRESHOLD = 3;

export function RollbackTimeline({ datasetId, currentRevisionId }: Props) {
  const { data: revisions, isLoading, error } = useRevisions(datasetId);
  const rollback = useRollback();

  const onRollback = (rev: Revision) => {
    const list = revisions ?? [];
    // revisions are newest-first; how many newer revisions exist than target.
    const targetIdx = list.findIndex((r) => r.id === rev.id);
    const isDeep = targetIdx >= DEEP_ROLLBACK_THRESHOLD;
    const msg = isDeep
      ? `Deep rollback: this discards the live state back to revision #${rev.revision_no} (${targetIdx} revisions back). History is preserved. Continue?`
      : `Roll back to revision #${rev.revision_no}? History is preserved.`;
    if (!window.confirm(msg)) return;
    rollback.mutate({ datasetId, targetRevisionId: rev.id });
  };

  return (
    <section className="timeline">
      <h2>Revisions</h2>
      {isLoading ? <p className="muted">Loading revisions…</p> : null}
      {error ? <p className="error-text">{error.message}</p> : null}
      {rollback.isError ? (
        <p className="error-text">{(rollback.error as Error).message}</p>
      ) : null}

      <ol className="timeline-list">
        {(revisions ?? []).map((rev) => {
          const isCurrent = rev.id === currentRevisionId;
          return (
            <li
              key={rev.id}
              className={`timeline-row ${isCurrent ? 'timeline-row--current' : ''}`}
            >
              <div className="timeline-main">
                <span className="timeline-no">#{rev.revision_no}</span>
                <span className="timeline-op">{rev.op}</span>
                {isCurrent ? <span className="badge badge--active">current</span> : null}
              </div>
              {rev.summary ? <p className="timeline-summary">{rev.summary}</p> : null}
              <div className="timeline-foot">
                <time className="muted">{new Date(rev.created_at).toLocaleString()}</time>
                {!isCurrent ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => onRollback(rev)}
                    disabled={rollback.isPending}
                  >
                    Roll back here
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default RollbackTimeline;
