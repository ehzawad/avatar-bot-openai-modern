import type { DatasetCard } from '../../../lib/api/types';
import { FileCard } from './FileCard';

interface Props {
  cards: DatasetCard[];
  activeId: string | null;
  loading?: boolean;
  error?: string | null;
  onOpen: (datasetId: string) => void;
  onRename: (datasetId: string, name: string) => void;
  onDelete: (datasetId: string) => void;
  onCreate: () => void;
  creating?: boolean;
  renamingId?: string | null;
  deletingId?: string | null;
}

export function FileCardFeed({
  cards,
  activeId,
  loading,
  error,
  onOpen,
  onRename,
  onDelete,
  onCreate,
  creating,
  renamingId,
  deletingId,
}: Props) {
  return (
    <section className="feed">
      <div className="feed-head">
        <h2>Pages</h2>
        <button type="button" className="btn" onClick={onCreate} disabled={creating}>
          {creating ? 'Creating…' : '+ New series'}
        </button>
      </div>

      {loading ? <p className="muted">Loading pages…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!loading && !error && cards.length === 0 ? (
        <p className="muted">No pages yet. Create a new series to begin recording.</p>
      ) : null}

      <div className="feed-grid">
        {cards.map((card) => (
          <FileCard
            key={card.id}
            card={card}
            isActive={card.id === activeId}
            onOpen={onOpen}
            onRename={onRename}
            onDelete={onDelete}
            renaming={renamingId === card.id}
            deleting={deletingId === card.id}
          />
        ))}
      </div>
    </section>
  );
}

export default FileCardFeed;
