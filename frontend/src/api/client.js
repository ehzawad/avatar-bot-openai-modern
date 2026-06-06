export class ApiClient {
  async health() {
    return this.#json('/api/health');
  }

  async config() {
    return this.#json('/api/config');
  }

  async createConversation() {
    return this.#json('/api/conversations', { method: 'POST' });
  }

  async sendMessage(conversationId, { message, voice, interactionMode = 'chat' }) {
    return this.#json(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice, interaction_mode: interactionMode }),
    });
  }

  async transcribe(blob) {
    const form = new FormData();
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
    form.append('audio', blob, `recording.${ext}`);
    return this.#json('/api/speech/transcriptions', { method: 'POST', body: form });
  }

  async #json(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof payload === 'string'
        ? payload
        : payload?.detail?.message || payload?.detail || payload?.message || response.statusText;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}
