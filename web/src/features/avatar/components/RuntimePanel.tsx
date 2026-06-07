import type { PublicConfig } from '../../../lib/api/types';
import { ModelUpload } from './ModelUpload';

export interface RuntimePanelProps {
  config: PublicConfig | null;
  voice: string;
  onVoiceChange: (voice: string) => void;
  onModelFile: (file: File) => Promise<void>;
  onStatus: (label: string, tone: 'busy' | 'ready' | 'error') => void;
  onMessage: (text: string) => void;
}

export function RuntimePanel({
  config,
  voice,
  onVoiceChange,
  onModelFile,
  onStatus,
  onMessage,
}: RuntimePanelProps) {
  const voices = config?.voices ?? [];

  return (
    <section className="panel config-panel">
      <div className="panel-title">Runtime</div>
      <dl className="runtime-grid">
        <dt>Model</dt>
        <dd title={config?.response_model}>{config?.response_model ?? '…'}</dd>
        <dt>Speech</dt>
        <dd title={config?.tts_model}>{config?.tts_model ?? '…'}</dd>
        <dt>Voice</dt>
        <dd>
          <select
            value={voice}
            onChange={(e) => onVoiceChange(e.target.value)}
            disabled={voices.length === 0}
            aria-label="Voice"
          >
            {voices.length === 0 ? (
              <option value="">…</option>
            ) : (
              voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))
            )}
          </select>
        </dd>
      </dl>
      <ModelUpload onFile={onModelFile} onStatus={onStatus} onMessage={onMessage} />
    </section>
  );
}
