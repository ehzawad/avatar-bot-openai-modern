export class ExpressionController {
  constructor() {
    this.vrm = null;
    this.activeEmotion = 'neutral';
    this.expressionTimeout = null;
  }

  bind(vrm) {
    this.vrm = vrm;
    this.activeEmotion = 'neutral';
  }

  setEmotion(emotion) {
    if (!this.vrm) return;
    this.activeEmotion = emotion || 'neutral';
    this.#resetEmotionPresets();
    const value = 0.9;
    switch (this.activeEmotion) {
      case 'joy':
        this.#set('happy', value); this.#set('joy', value); break;
      case 'sorrow':
        this.#set('sad', value); this.#set('sorrow', value); break;
      case 'angry':
        this.#set('angry', value); break;
      case 'fun':
        this.#set('relaxed', value); this.#set('fun', value); break;
      case 'surprised':
        this.#set('surprised', value); break;
      default:
        break;
    }
    clearTimeout(this.expressionTimeout);
    this.expressionTimeout = setTimeout(() => this.setEmotion('neutral'), 4800);
  }

  setMouth(value) {
    this.#set('aa', Math.max(0, Math.min(1, value)));
  }

  setBlink(value) {
    this.#set('blink', Math.max(0, Math.min(1, value)));
  }

  #resetEmotionPresets() {
    for (const name of ['happy', 'joy', 'angry', 'sad', 'sorrow', 'relaxed', 'fun', 'surprised']) {
      this.#set(name, 0);
    }
  }

  #set(preset, value) {
    if (!this.vrm) return;
    if (this.vrm.expressionManager) {
      try { this.vrm.expressionManager.setValue(preset, value); } catch (_) {}
      return;
    }

    const meshes = this.vrm.morphTargetMeshes || [];
    const fallback = this.vrm.fallbackMappings;
    if (!fallback) return;
    for (const mesh of meshes) {
      const influences = mesh.morphTargetInfluences;
      const mapping = fallback.get(mesh);
      if (!influences || !mapping) continue;
      if (preset === 'aa') {
        for (const idx of mapping.mouth) influences[idx] = Math.min(value * 1.8, 1);
      }
      if (preset === 'blink') {
        for (const idx of mapping.blink) influences[idx] = value;
      }
    }
  }
}
