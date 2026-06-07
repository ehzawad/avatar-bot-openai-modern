import { useEffect, useState } from 'react';
import type { DatasetDetail, EvalPart, Line, Role } from '../../../lib/api/types';
import {
  useAddLine,
  useDeleteLine,
  useEditLine,
  useReorder,
} from '../../../lib/api/studioQueries';
import {
  clearDraftHistory,
  redoDraft,
  undoDraft,
  useDraftStore,
  useTemporalDraftStore,
} from '../editor/draftStore';

const ROLES: Role[] = ['user', 'assistant', 'interviewer', 'system'];
const EVAL_PARTS: EvalPart[] = ['prompt', 'context', 'expected', 'ignored'];

interface Props {
  dataset: DatasetDetail;
  highlightLineId: string | null;
}

// Per-row tag editor: local input synced to the line, committed (PATCH) on blur/Enter.
function LineTagField({
  line,
  baseRevisionId,
  onCommit,
  disabled,
}: {
  line: Line;
  baseRevisionId: number | undefined;
  onCommit: (lineId: string, tag: string | null, baseRevisionId: number | undefined) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(line.tag ?? '');

  // Keep in sync if the server value changes (e.g. after refetch/rollback).
  useEffect(() => {
    setValue(line.tag ?? '');
  }, [line.tag]);

  const commit = () => {
    const trimmed = value.trim();
    const next = trimmed === '' ? null : trimmed;
    if (next === (line.tag ?? null)) return;
    onCommit(line.id, next, baseRevisionId);
  };

  return (
    <label className="line-tag-field">
      <span className="field-label">tag</span>
      <input
        className="input input--sm"
        type="text"
        value={value}
        placeholder="(none)"
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setValue(line.tag ?? '');
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

export function LineEditor({ dataset, highlightLineId }: Props) {
  const editLine = useEditLine();
  const deleteLine = useDeleteLine();
  const reorder = useReorder();
  const addLine = useAddLine();

  const draft = useDraftStore((s) => s.draft);
  const begin = useDraftStore((s) => s.begin);
  const setText = useDraftStore((s) => s.setText);
  const setRole = useDraftStore((s) => s.setRole);
  const setEvalPart = useDraftStore((s) => s.setEvalPart);
  const cancel = useDraftStore((s) => s.cancel);
  const commit = useDraftStore((s) => s.commit);

  const pastStates = useTemporalDraftStore((s) => s.pastStates.length);
  const futureStates = useTemporalDraftStore((s) => s.futureStates.length);

  const baseRevisionId = dataset.current_revision_id ?? undefined;
  const lines = dataset.lines;

  // Track recently-deleted lines so the user can one-click undo (re-add).
  const [deletedStack, setDeletedStack] = useState<Line[]>([]);

  const [newText, setNewText] = useState('');
  const [newRole, setNewRole] = useState<Role>('user');
  const [newEvalPart, setNewEvalPart] = useState<EvalPart>('ignored');
  const [newTag, setNewTag] = useState('');

  const startEdit = (line: Line) => {
    begin({
      lineId: line.id,
      text: line.text,
      role: line.role,
      eval_part: line.eval_part,
    });
  };

  const saveEdit = () => {
    const result = commit();
    if (!result) return;
    editLine.mutate(
      {
        datasetId: dataset.id,
        lineId: result.lineId,
        body: {
          text: result.text,
          role: result.role,
          eval_part: result.eval_part,
          base_revision_id: baseRevisionId,
        },
      },
      { onSuccess: () => clearDraftHistory() },
    );
  };

  const cancelEdit = () => {
    cancel();
    clearDraftHistory();
  };

  const setReview = (line: Line, review_status: Line['review_status']) => {
    editLine.mutate({
      datasetId: dataset.id,
      lineId: line.id,
      body: { review_status, base_revision_id: baseRevisionId },
    });
  };

  const commitTag = (lineId: string, tag: string | null, baseRev: number | undefined) => {
    editLine.mutate({
      datasetId: dataset.id,
      lineId,
      body: { tag, base_revision_id: baseRev },
    });
  };

  const onDelete = (line: Line) => {
    deleteLine.mutate(
      { datasetId: dataset.id, lineId: line.id, baseRevisionId },
      { onSuccess: () => setDeletedStack((s) => [...s, line]) },
    );
  };

  const undoDelete = () => {
    const last = deletedStack[deletedStack.length - 1];
    if (!last) return;
    addLine.mutate(
      {
        datasetId: dataset.id,
        body: {
          text: last.text,
          role: last.role,
          eval_part: last.eval_part,
          conversation_key: last.conversation_key ?? undefined,
          turn_index: last.turn_index ?? undefined,
          tag: last.tag ?? undefined,
          base_revision_id: baseRevisionId,
        },
      },
      { onSuccess: () => setDeletedStack((s) => s.slice(0, -1)) },
    );
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= lines.length) return;
    const ids = lines.map((l) => l.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved);
    reorder.mutate({
      datasetId: dataset.id,
      body: { line_ids: ids, base_revision_id: baseRevisionId },
    });
  };

  const addManual = () => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    const trimmedTag = newTag.trim();
    addLine.mutate(
      {
        datasetId: dataset.id,
        body: {
          text: trimmed,
          role: newRole,
          eval_part: newEvalPart,
          tag: trimmedTag === '' ? null : trimmedTag,
          base_revision_id: baseRevisionId,
        },
      },
      {
        onSuccess: () => {
          setNewText('');
          clearDraftHistory();
        },
      },
    );
  };

  const mutating =
    editLine.isPending || deleteLine.isPending || reorder.isPending || addLine.isPending;

  return (
    <section className="editor">
      <div className="editor-head">
        <h2>
          {dataset.name} · {lines.length} lines
        </h2>
        {deletedStack.length > 0 ? (
          <button type="button" className="btn btn--sm" onClick={undoDelete}>
            Undo delete ({deletedStack.length})
          </button>
        ) : null}
      </div>

      {lines.length === 0 ? (
        <p className="muted">No lines yet — record or add a manual line below.</p>
      ) : null}

      <ol className="line-list">
        {lines.map((line, index) => {
          const editing = draft?.lineId === line.id;
          const highlighted = line.id === highlightLineId;
          return (
            <li
              key={line.id}
              className={`line-row line-row--${line.review_status} ${
                highlighted ? 'line-row--new' : ''
              }`}
            >
              <div className="line-idx">{line.line_index}</div>

              <div className="line-body">
                {editing && draft ? (
                  <>
                    <textarea
                      className="textarea bn"
                      autoFocus
                      value={draft.text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <div className="line-edit-controls">
                      <select
                        className="select select--sm"
                        value={draft.role}
                        onChange={(e) => setRole(e.target.value as Role)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <select
                        className="select select--sm"
                        value={draft.eval_part}
                        onChange={(e) => setEvalPart(e.target.value as EvalPart)}
                      >
                        {EVAL_PARTS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={undoDraft}
                        disabled={pastStates === 0}
                        title="Undo edit"
                      >
                        ↶
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={redoDraft}
                        disabled={futureStates === 0}
                        title="Redo edit"
                      >
                        ↷
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        onClick={saveEdit}
                        disabled={editLine.isPending}
                      >
                        Save
                      </button>
                      <button type="button" className="btn btn--sm" onClick={cancelEdit}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="line-text bn">{line.text}</p>
                    <div className="line-tags">
                      <span className="tag">{line.role}</span>
                      <span className="tag">{line.eval_part}</span>
                      <span className="tag">{line.source}</span>
                      <span className={`tag tag--${line.review_status}`}>
                        {line.review_status}
                      </span>
                    </div>
                    <LineTagField
                      line={line}
                      baseRevisionId={baseRevisionId}
                      onCommit={commitTag}
                      disabled={editLine.isPending}
                    />
                  </>
                )}
              </div>

              {!editing ? (
                <div className="line-actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => move(index, -1)}
                    disabled={index === 0 || mutating}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => move(index, 1)}
                    disabled={index === lines.length - 1 || mutating}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => startEdit(line)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--accept"
                    onClick={() => setReview(line, 'accepted')}
                    disabled={line.review_status === 'accepted'}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--reject"
                    onClick={() => setReview(line, 'rejected')}
                    disabled={line.review_status === 'rejected'}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => onDelete(line)}
                    disabled={deleteLine.isPending}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="add-line">
        <h3>Add manual line</h3>
        <textarea
          className="textarea bn"
          placeholder="Type a line (Bengali / code-switch)…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
        />
        <div className="add-line-controls">
          <select
            className="select select--sm"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            className="select select--sm"
            value={newEvalPart}
            onChange={(e) => setNewEvalPart(e.target.value as EvalPart)}
          >
            {EVAL_PARTS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            className="input input--sm"
            type="text"
            placeholder="tag (optional)"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={addManual}
            disabled={!newText.trim() || addLine.isPending}
          >
            Add line
          </button>
        </div>
      </div>
    </section>
  );
}

export default LineEditor;
