export class MicRecorder extends EventTarget {
  constructor() {
    super();
    this.recorder = null;
    this.stream = null;
    this.audioContext = null;
    this.source = null;
    this.analyser = null;
    this.timeData = null;
    this.monitorFrame = null;
    this.chunks = [];
    this.recording = false;
    this.options = {};
    this.startedAt = 0;
    this.speechStarted = false;
    this.speechStartedAt = 0;
    this.lastVoiceAt = 0;
    this.stopReason = 'manual';
    this.skipDispatch = false;
  }

  async start(options = {}) {
    if (this.recording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support microphone capture.');
    }
    this.options = {
      mode: 'manual',
      autoStopOnSilence: false,
      speechThreshold: 0.035,
      silenceMs: 950,
      minSpeechMs: 360,
      warmupMs: 250,
      idleTimeoutMs: null,
      ...options,
    };
    this.stopReason = 'manual';
    this.skipDispatch = false;
    this.speechStarted = false;
    this.speechStartedAt = 0;
    this.lastVoiceAt = 0;
    this.startedAt = performance.now();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.recorder = new MediaRecorder(this.stream, { mimeType });
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onstop = () => {
      const type = this.recorder?.mimeType || 'audio/webm';
      const detail = {
        blob: new Blob(this.chunks, { type }),
        mode: this.options.mode,
        autoStop: this.options.autoStopOnSilence,
        reason: this.stopReason,
        speechStarted: this.speechStarted,
      };
      const shouldDispatch = !this.skipDispatch;
      this.#cleanup();
      this.recording = false;
      if (shouldDispatch) this.dispatchEvent(new CustomEvent('recording', { detail }));
    };
    this.recording = true;
    if (this.options.autoStopOnSilence) this.#startSilenceMonitor();
    this.recorder.start(250);
  }

  stop(reason = 'manual') {
    this.stopReason = reason;
    if (this.recorder && this.recording) {
      this.recorder.stop();
    }
  }

  cancel() {
    this.skipDispatch = true;
    this.stopReason = 'cancel';
    this.chunks = [];
    if (this.recorder && this.recording && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    } else {
      this.#cleanup();
      this.recording = false;
    }
  }

  #startSilenceMonitor() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    this.audioContext = new AudioContextClass();
    if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);

    const tick = () => {
      if (!this.recording || !this.analyser) return;

      const rms = this.#rms();
      const now = performance.now();
      const elapsed = now - this.startedAt;
      const speaking = elapsed > this.options.warmupMs && rms >= this.options.speechThreshold;

      if (speaking) {
        if (!this.speechStarted) this.speechStartedAt = now;
        this.speechStarted = true;
        this.lastVoiceAt = now;
      }

      this.dispatchEvent(new CustomEvent('level', { detail: { rms, speaking, speechStarted: this.speechStarted } }));

      const heardEnough = this.speechStarted && now - this.speechStartedAt >= this.options.minSpeechMs;
      const paused = this.speechStarted && now - this.lastVoiceAt >= this.options.silenceMs;
      if (heardEnough && paused) {
        this.stop('silence');
        return;
      }

      if (!this.speechStarted && this.options.idleTimeoutMs && elapsed >= this.options.idleTimeoutMs) {
        this.dispatchEvent(new CustomEvent('idle', { detail: { mode: this.options.mode } }));
        this.cancel();
        return;
      }

      this.monitorFrame = requestAnimationFrame(tick);
    };

    this.monitorFrame = requestAnimationFrame(tick);
  }

  #rms() {
    this.analyser.getByteTimeDomainData(this.timeData);
    let sum = 0;
    for (const value of this.timeData) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.sqrt(sum / this.timeData.length);
  }

  #stopMonitor() {
    if (this.monitorFrame) {
      cancelAnimationFrame(this.monitorFrame);
      this.monitorFrame = null;
    }
    this.source?.disconnect?.();
    this.source = null;
    this.analyser = null;
    this.timeData = null;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  #cleanup() {
    this.#stopMonitor();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.recorder = null;
    this.recording = false;
  }
}
