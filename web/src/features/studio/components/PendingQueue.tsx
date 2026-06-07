import type { PendingCapture } from '../recording/pendingStore';

interface Props {
  items: PendingCapture[];
  onRetrySame: (item: PendingCapture) => void;
  onRetryBest: (item: PendingCapture) => void;
  onEdit: (item: PendingCapture) => void;
  onDiscard: (item: PendingCapture) => void;
}

function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function PendingQueue({ items, onRetrySame, onRetryBest, onEdit, onDiscard }: Props) {
  if (items.length === 0) return null;

  return (
    <section className="pending">
      <h2>Captures in progress</h2>
      <ul className="pending-list">
        {items.map((item) => (
          <li
            key={item.client_segment_id}
            className={`pending-row pending-row--${item.status}`}
          >
            <div className="pending-main">
              <span className={`pending-status pending-status--${item.status}`}>
                {item.status === 'uploading' ? 'Uploading…' : 'Failed'}
              </span>
              <span className="muted">
                {fmtDuration(item.durationMs)} · {item.tier} · {item.language}
                {item.tag ? ` · #${item.tag}` : ''}
              </span>
            </div>
            {item.error ? <p className="error-text">{item.error}</p> : null}

            {item.status === 'failed' ? (
              <div className="pending-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => onRetrySame(item)}
                >
                  Retry same
                </button>
                {item.tier !== 'best' ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => onRetryBest(item)}
                  >
                    Retry Best
                  </button>
                ) : null}
                <button type="button" className="btn btn--sm" onClick={() => onEdit(item)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Discard this capture? The audio for this segment will be lost.',
                      )
                    ) {
                      onDiscard(item);
                    }
                  }}
                >
                  Discard
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default PendingQueue;
