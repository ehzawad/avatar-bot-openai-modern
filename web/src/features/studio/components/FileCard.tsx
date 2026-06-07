import { useState } from 'react';
import type { DatasetCard } from '../../../lib/api/types';
import { downloadCsvUrl, downloadJsonlUrl, downloadTxtUrl } from '../../../lib/api/studioClient';

interface Props {
  card: DatasetCard;
  reviewedCount?: number;
  isActive: boolean;
  onOpen: (datasetId: string) => void;
  onRename: (datasetId: string, name: string) => void;
  onDelete: (datasetId: string) => void;
  renaming?: boolean;
  deleting?: boolean;
}

export function FileCard({
  card,
  reviewedCount,
  isActive,
  onOpen,
  onRename,
  onDelete,
  renaming,
  deleting,
}: Props) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(card.name);

  const commitRename = () => {
    const trimmed = nameValue.trim();
    setEditingName(false);
    if (trimmed && trimmed !== card.name) {
      onRename(card.id, trimmed);
    } else {
      setNameValue(card.name);
    }
  };

  return (
    <div className={`filecard ${isActive ? 'filecard--active' : ''}`}>
      <div className="filecard-head">
        {editingName ? (
          <input
            className="input"
            autoFocus
            value={nameValue}
            disabled={renaming}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setNameValue(card.name);
                setEditingName(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="filecard-title"
            onClick={() => onOpen(card.id)}
            title="Open page"
          >
            {card.name}
          </button>
        )}
        {isActive ? <span className="badge badge--active">active</span> : null}
        {card.status !== 'active' ? <span className="badge">{card.status}</span> : null}
      </div>

      <div className="filecard-meta">
        <span>
          {card.line_count}/{card.page_size} lines
        </span>
        {typeof reviewedCount === 'number' ? <span>· {reviewedCount} reviewed</span> : null}
        <span>· page {card.page_no}</span>
      </div>

      <div className="filecard-actions">
        <button type="button" className="btn btn--sm" onClick={() => onOpen(card.id)}>
          Open
        </button>
        <a className="btn btn--sm" href={downloadTxtUrl(card.id)} download>
          .txt
        </a>
        <a className="btn btn--sm" href={downloadJsonlUrl(card.id)} download>
          .jsonl
        </a>
        <a className="btn btn--sm" href={downloadCsvUrl(card.id)} download>
          .csv
        </a>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setNameValue(card.name);
            setEditingName(true);
          }}
          disabled={renaming}
        >
          Rename
        </button>
        <button
          type="button"
          className="btn btn--sm btn--danger"
          disabled={deleting}
          onClick={() => {
            if (window.confirm(`Delete "${card.name}"? This soft-deletes the page.`)) {
              onDelete(card.id);
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export default FileCard;
