import type { StatusTone } from '../hooks/useAvatarChat';

export interface StatusPillProps {
  label: string;
  tone: StatusTone;
}

export function StatusPill({ label, tone }: StatusPillProps) {
  return (
    <div className="status-pill">
      <span className={`dot ${tone}`} />
      <span className="status-text">{label}</span>
    </div>
  );
}
