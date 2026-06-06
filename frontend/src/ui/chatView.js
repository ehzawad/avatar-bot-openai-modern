export class ChatView {
  constructor(dom) {
    this.dom = dom;
  }

  add(role, text) {
    const node = this.dom.template.content.firstElementChild.cloneNode(true);
    node.classList.add(role);
    node.querySelector('.label').textContent = role === 'assistant' ? 'Aria' : role === 'user' ? 'You' : 'System';
    node.querySelector('.bubble').textContent = text;
    this.dom.messages.appendChild(node);
    this.dom.messages.scrollTop = this.dom.messages.scrollHeight;
  }

  clear() {
    this.dom.messages.innerHTML = '';
  }

  status(text, tone = 'ready') {
    this.dom.statusText.textContent = text;
    this.dom.statusDot.className = `dot ${tone}`;
  }

  setBusy(value) {
    this.dom.send.disabled = value;
    this.dom.input.disabled = value;
    this.dom.newChat.disabled = value;
  }

  setLiveMode(value) {
    this.dom.liveMode.classList.toggle('active', value);
    this.dom.liveMode.setAttribute('aria-pressed', String(value));
  }

  configureRuntime(config) {
    this.dom.runtimeModel.textContent = config.response_model;
    this.dom.runtimeTts.textContent = config.tts_model;
    this.dom.voiceSelect.innerHTML = '';
    for (const voice of config.voices) {
      const option = document.createElement('option');
      option.value = voice;
      option.textContent = voice;
      if (voice === config.default_voice) option.selected = true;
      this.dom.voiceSelect.appendChild(option);
    }
  }
}
