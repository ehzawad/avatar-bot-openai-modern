export class AudioPlayer extends EventTarget {
  constructor() {
    super();
    this.context = null;
    this.source = null;
    this.analyser = null;
    this.frequencyData = null;
    this.playing = false;
  }

  async playDataUrl(dataUrl) {
    await this.stop();
    if (!this.context) {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    const arrayBuffer = this.#dataUrlToArrayBuffer(dataUrl);
    const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
    this.source = this.context.createBufferSource();
    this.source.buffer = audioBuffer;

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

    this.source.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.source.onended = () => {
      this.playing = false;
      this.dispatchEvent(new Event('ended'));
    };
    this.playing = true;
    this.source.start(0);
  }

  async stop() {
    this.playing = false;
    if (this.source) {
      try { this.source.stop(); } catch (_) {}
      this.source.disconnect();
      this.source = null;
    }
    this.analyser = null;
    this.frequencyData = null;
  }

  mouthLevel() {
    if (!this.playing || !this.analyser || !this.frequencyData) return 0;
    this.analyser.getByteFrequencyData(this.frequencyData);
    let sum = 0;
    for (let i = 0; i < this.frequencyData.length; i += 1) sum += this.frequencyData[i];
    const avg = sum / this.frequencyData.length;
    return Math.min(avg / 48, 1);
  }

  #dataUrlToArrayBuffer(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const raw = window.atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }
}
