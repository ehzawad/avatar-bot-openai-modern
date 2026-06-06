export class AppState extends EventTarget {
  constructor() {
    super();
    this.conversationId = null;
    this.voice = 'alloy';
    this.busy = false;
    this.liveMode = false;
  }

  setConversation(id) {
    this.conversationId = id;
    this.emit('conversation', id);
  }

  setVoice(voice) {
    this.voice = voice;
    this.emit('voice', voice);
  }

  setBusy(value) {
    this.busy = value;
    this.emit('busy', value);
  }

  setLiveMode(value) {
    this.liveMode = value;
    this.emit('liveMode', value);
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
