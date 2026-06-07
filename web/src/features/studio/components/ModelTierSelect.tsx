import type { Tier } from '../../../lib/api/types';

const TIER_OPTIONS: { value: Tier; label: string }[] = [
  { value: 'best', label: 'Best (gpt-4o-transcribe)' },
  { value: 'fast', label: 'Fast (gpt-4o-mini-transcribe)' },
];

interface Props {
  value: Tier;
  onChange: (tier: Tier) => void;
  disabled?: boolean;
  id?: string;
}

export function ModelTierSelect({ value, onChange, disabled, id }: Props) {
  return (
    <label className="field">
      <span className="field-label">Tier</span>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Tier)}
      >
        {TIER_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default ModelTierSelect;
