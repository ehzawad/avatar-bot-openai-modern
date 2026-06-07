import { useEffect } from 'react';
import type { DatasetCard, Tier } from '../../../lib/api/types';
import type { RecorderState } from '../../../lib/audio/useRecorder';
import { ModelTierSelect } from './ModelTierSelect';

const LANGUAGES: { value: string; label: string }[] = [
  { value: 'bn', label: 'Bengali (bn)' },
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English (en)' },
];

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

interface Props {
  target: DatasetCard | null;
  recorderState: RecorderState;
  level: number;
  recorderError: string | null;
  tier: Tier;
  language: string;
  autoRoll: boolean;
  tag: string;
  onTierChange: (tier: Tier) => void;
  onLanguageChange: (language: string) => void;
  onTagChange: (tag: string) => void;
  onToggleRecord: () => void;
}

export function RecordBar({
  target,
  recorderState,
  level,
  recorderError,
  tier,
  language,
  autoRoll,
  tag,
  onTierChange,
  onLanguageChange,
  onTagChange,
  onToggleRecord,
}: Props) {
  const isRecording = recorderState === 'recording';
  const isBusy = recorderState === 'requesting_mic' || recorderState === 'stopping';

  // Space hotkey — only when focus is NOT in an input/textarea/contenteditable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isEditableTarget(document.activeElement)) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      onToggleRecord();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggleRecord]);

  const targetLabel = target
    ? `Appending to: Page ${String(target.page_no).padStart(2, '0')} · ${target.line_count}/${target.page_size}${autoRoll ? ' · auto-roll' : ''}`
    : 'No active page — create or select one';

  const levelPct = Math.min(100, Math.round(level * 320));

  let recordLabel = 'Record';
  if (isRecording) recordLabel = 'Stop';
  else if (recorderState === 'requesting_mic') recordLabel = 'Starting…';
  else if (recorderState === 'stopping') recordLabel = 'Stopping…';

  return (
    <div className="recordbar">
      <div className="recordbar-main">
        <button
          type="button"
          className={`record-btn ${isRecording ? 'record-btn--on' : ''}`}
          onClick={onToggleRecord}
          disabled={isBusy || !target}
          aria-pressed={isRecording}
          title="Press Space to toggle"
        >
          <span className="record-dot" />
          {recordLabel}
        </button>

        <div className="level-meter" aria-hidden>
          <div
            className={`level-fill ${isRecording ? 'level-fill--on' : ''}`}
            style={{ width: `${levelPct}%` }}
          />
        </div>

        <span className="hotkey-hint">Space</span>
      </div>

      <div className="recordbar-controls">
        <ModelTierSelect value={tier} onChange={onTierChange} disabled={isRecording} />
        <label className="field">
          <span className="field-label">Language</span>
          <select
            className="select"
            value={language}
            disabled={isRecording}
            onChange={(e) => onLanguageChange(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tag name</span>
          <input
            className="input"
            type="text"
            value={tag}
            placeholder="optional tag"
            disabled={isRecording}
            onChange={(e) => onTagChange(e.target.value)}
            title="Applied as the tag for each capture (empty = no tag)"
          />
        </label>
      </div>

      <div className="recordbar-target">{targetLabel}</div>
      {recorderError ? <div className="recordbar-error">{recorderError}</div> : null}
    </div>
  );
}

export default RecordBar;
