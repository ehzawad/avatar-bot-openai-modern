import { useRef, useState, type ChangeEvent } from 'react';

export interface ModelUploadProps {
  onFile: (file: File) => Promise<void>;
  onStatus: (label: string, tone: 'busy' | 'ready' | 'error') => void;
  onMessage: (text: string) => void;
  disabled?: boolean;
}

export function ModelUpload({ onFile, onStatus, onMessage, disabled }: ModelUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so selecting the same file again re-triggers change.
    event.target.value = '';
    if (!file) return;
    setLoading(true);
    onStatus('Loading uploaded avatar', 'busy');
    try {
      await onFile(file);
      onStatus('Ready', 'ready');
      onMessage(`Loaded avatar: ${file.name}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      onStatus('Avatar load failed', 'error');
      onMessage(`Could not load avatar: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <label className="file-label">
      <input
        ref={inputRef}
        type="file"
        accept=".vrm,.glb,.gltf"
        onChange={handleChange}
        disabled={disabled || loading}
      />
      {loading ? 'Loading avatar…' : 'Load VRM/GLB avatar'}
    </label>
  );
}
