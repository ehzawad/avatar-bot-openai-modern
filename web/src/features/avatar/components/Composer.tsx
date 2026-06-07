import { useState, type KeyboardEvent } from 'react';

export interface ComposerProps {
  liveMode: boolean;
  recording: boolean;
  canSend: boolean;
  canRecord: boolean;
  canStop: boolean;
  micLevel: number;
  onSend: (text: string) => void;
  onMicClick: () => void;
  onToggleLive: () => void;
}

export function Composer({
  liveMode,
  recording,
  canSend,
  canRecord,
  canStop,
  micLevel,
  onSend,
  onMicClick,
  onToggleLive,
}: ComposerProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || !canSend) return;
    setValue('');
    onSend(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  // mic is clickable when recording (to stop), when idle+able to record, or in live mode (to exit).
  const micEnabled = liveMode || canStop || canRecord;

  return (
    <footer className="composer panel">
      <button
        type="button"
        className={`round-button${recording ? ' recording' : ''}`}
        title={recording ? 'Stop recording' : 'Record voice'}
        aria-label={recording ? 'Stop recording' : 'Record voice'}
        aria-pressed={recording}
        onClick={onMicClick}
        disabled={!micEnabled}
        style={
          recording
            ? { boxShadow: `0 0 ${8 + Math.round(micLevel * 28)}px rgba(239,68,68,0.6)` }
            : undefined
        }
      >
        ●
      </button>
      <button
        type="button"
        className={`live-button${liveMode ? ' active' : ''}`}
        title="Live interview mode"
        aria-pressed={liveMode}
        onClick={onToggleLive}
      >
        Live
      </button>
      <input
        type="text"
        autoComplete="off"
        placeholder="Ask Aria something..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={liveMode}
        aria-label="Message Aria"
      />
      <button
        type="button"
        className="send-button"
        onClick={submit}
        disabled={!canSend || value.trim().length === 0}
      >
        Send
      </button>
    </footer>
  );
}
