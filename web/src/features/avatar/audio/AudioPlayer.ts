// Imperative TTS playback engine — ports frontend/src/audio/player.js verbatim in
// behavior, extended with the token/result model the chat state machine needs
// (WEB_CONTRACT §8). ONE AudioContext per instance; mouth level drives the avatar.
//
// playDataUrl(url, token) resolves to:
//   'ended'      — the buffer finished playing on its own
//   'stopped'    — explicitly stop()'d (e.g. New chat, user interrupt)
//   'superseded' — a newer playDataUrl() call replaced this one
//
// No Three / React imports here (kept imperative, owned by useAvatarChat).

export type PlaybackResult = 'ended' | 'stopped' | 'superseded';

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ||
    null
  );
}

export class AudioPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frequencyData: Uint8Array | null = null;
  private playing = false;
  private disposed = false;

  // The currently-resolving playback (so a new play / stop can settle the old one).
  private current: {
    resolve: (result: PlaybackResult) => void;
    settled: boolean;
  } | null = null;

  private ensureContext(): AudioContext {
    if (!this.context) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) throw new Error('Web Audio API is not supported in this browser.');
      this.context = new Ctor();
    }
    return this.context;
  }

  /**
   * Resume/create the AudioContext from within a user gesture to satisfy the
   * browser autoplay policy. Safe to call repeatedly.
   */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      /* ignore — playback will retry resume */
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Decode + play a data: URL. Any in-flight playback is settled as 'superseded'.
   * Resolves once this playback ends, is stopped, or is itself superseded.
   */
  async playDataUrl(dataUrl: string, _token?: unknown): Promise<PlaybackResult> {
    if (this.disposed) return 'stopped';

    // Supersede any current playback before tearing it down.
    this.settleCurrent('superseded');
    this.teardownSource();

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    if (this.disposed) return 'stopped';

    const arrayBuffer = this.dataUrlToArrayBuffer(dataUrl);
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (this.disposed) return 'stopped';

    // A newer play may have started while we were decoding — if so, abandon this one.
    if (this.current) {
      return 'superseded';
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);

    source.connect(analyser);
    analyser.connect(ctx.destination);

    this.source = source;
    this.analyser = analyser;
    this.frequencyData = frequencyData;

    return new Promise<PlaybackResult>((resolve) => {
      const entry = { resolve, settled: false };
      this.current = entry;

      source.onended = () => {
        // Only treat as a natural end if this source is still the active one and
        // playback wasn't already settled by stop()/supersede.
        if (this.source === source) {
          this.playing = false;
          this.teardownSource();
        }
        if (this.current === entry) this.current = null;
        if (!entry.settled) {
          entry.settled = true;
          resolve('ended');
        }
      };

      this.playing = true;
      source.start(0);
    });
  }

  /**
   * Stop current playback (resolves the pending playDataUrl as 'stopped' unless a
   * reason of 'superseded' is given). Idempotent.
   */
  stop(reason: Exclude<PlaybackResult, 'ended'> = 'stopped'): void {
    this.settleCurrent(reason);
    this.teardownSource();
    this.playing = false;
  }

  /** Port of player.js mouthLevel(): freq-average / 48, clamped to [0,1]. */
  getMouthLevel(): number {
    if (!this.playing || !this.analyser || !this.frequencyData) return 0;
    this.analyser.getByteFrequencyData(this.frequencyData as unknown as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.frequencyData.length; i += 1) sum += this.frequencyData[i];
    const avg = sum / this.frequencyData.length;
    return Math.min(avg / 48, 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settleCurrent('stopped');
    this.teardownSource();
    this.playing = false;
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
  }

  private settleCurrent(result: PlaybackResult): void {
    const entry = this.current;
    if (entry && !entry.settled) {
      entry.settled = true;
      entry.resolve(result);
    }
    this.current = null;
  }

  private teardownSource(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        /* ignore */
      }
      this.analyser = null;
    }
    this.frequencyData = null;
  }

  private dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
    const base64 = dataUrl.split(',')[1] || '';
    const raw = window.atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }
}
