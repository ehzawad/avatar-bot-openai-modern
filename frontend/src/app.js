import { ApiClient } from './api/client.js';
import { AppState } from './core/state.js';
import { AudioPlayer } from './audio/player.js';
import { MicRecorder } from './audio/recorder.js';
import { AvatarScene } from './avatar/avatarScene.js';
import { dom } from './ui/dom.js';
import { ChatView } from './ui/chatView.js';

const api = new ApiClient();
const state = new AppState();
const view = new ChatView(dom);
const audio = new AudioPlayer();
const recorder = new MicRecorder();
const avatar = new AvatarScene(dom.canvasRoot, audio);

async function boot() {
  bindEvents();
  view.status('Checking backend', 'busy');
  const [health, config] = await Promise.all([api.health(), api.config()]);
  view.configureRuntime(config);
  state.setVoice(config.default_voice);

  if (!health.openai_configured) {
    view.status('Missing OPENAI_API_KEY', 'error');
    view.add('system', 'OPENAI_API_KEY is not set. Stop the server, export the key in your shell, then restart.');
  } else {
    view.status('Loading avatar', 'busy');
  }

  await avatar.init();
  await newConversation(false);
  view.status(health.openai_configured ? 'Ready' : 'Backend key missing', health.openai_configured ? 'ready' : 'error');
}

function bindEvents() {
  dom.send.addEventListener('click', () => submitTypedMessage());
  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) submitTypedMessage();
  });
  dom.newChat.addEventListener('click', () => newConversation(true));
  dom.liveMode.addEventListener('click', () => {
    toggleLiveMode().catch((error) => {
      state.setLiveMode(false);
      view.setLiveMode(false);
      handleError(error, 'Mic error');
    });
  });
  dom.voiceSelect.addEventListener('change', (event) => state.setVoice(event.target.value));
  dom.modelFile.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      view.status('Loading uploaded avatar', 'busy');
      await avatar.loadUploadedFile(file);
      view.status('Ready', 'ready');
      view.add('system', `Loaded avatar: ${file.name}`);
    } catch (error) {
      console.error(error);
      view.status('Avatar load failed', 'error');
      view.add('system', `Could not load avatar: ${error.message}`);
    }
  });

  dom.mic.addEventListener('click', async () => {
    if (state.liveMode) {
      stopLiveMode();
      return;
    }
    if (recorder.recording) {
      dom.mic.classList.remove('recording');
      recorder.stop();
      return;
    }
    try {
      await audio.stop();
      await recorder.start({ mode: 'manual' });
      dom.mic.classList.add('recording');
      view.status('Recording', 'busy');
    } catch (error) {
      view.status('Mic error', 'error');
      view.add('system', error.message);
    }
  });

  recorder.addEventListener('recording', async (event) => {
    dom.mic.classList.remove('recording');
    const detail = event.detail || {};
    const blob = detail.blob || detail;
    const liveCapture = detail.mode === 'live';
    if (liveCapture && !state.liveMode) return;
    if (!blob || blob.size < 100) {
      view.status(state.liveMode ? 'Listening' : 'Ready', state.liveMode ? 'busy' : 'ready');
      if (state.liveMode) scheduleLiveListening(250);
      return;
    }
    try {
      setBusy(true, liveCapture ? 'Pause detected' : 'Transcribing');
      const result = await api.transcribe(blob);
      if (!result.text) {
        if (!liveCapture) view.add('system', 'No speech was detected.');
        view.status(state.liveMode ? 'Listening' : 'Ready', state.liveMode ? 'busy' : 'ready');
        setBusy(false);
        if (state.liveMode) scheduleLiveListening(300);
        return;
      }
      await sendMessage(result.text, { interactionMode: liveCapture ? 'live_interview' : 'chat' });
    } catch (error) {
      handleError(error, liveCapture ? 'Live reply failed' : 'Transcription failed');
    } finally {
      setBusy(false);
      if (state.liveMode && !audio.playing && !recorder.recording) scheduleLiveListening(450);
    }
  });

  recorder.addEventListener('idle', (event) => {
    if (event.detail?.mode !== 'live' || !state.liveMode) return;
    dom.mic.classList.remove('recording');
    view.status('Listening', 'busy');
    scheduleLiveListening(300);
  });

  audio.addEventListener('ended', () => {
    if (state.liveMode) scheduleLiveListening(250);
    else view.status('Ready', 'ready');
  });
}

async function newConversation(showMessage) {
  const created = await api.createConversation();
  state.setConversation(created.conversation_id);
  view.clear();
  if (showMessage) view.add('system', 'Started a new conversation.');
  else view.add('system', 'Ready. Your API key stays on the server; the browser never sees it.');
  view.status('Ready', 'ready');
}

async function submitTypedMessage() {
  const text = dom.input.value.trim();
  if (!text || state.busy) return;
  dom.input.value = '';
  await sendMessage(text, { interactionMode: state.liveMode ? 'live_interview' : 'chat' });
}

async function sendMessage(text, { interactionMode = 'chat' } = {}) {
  if (!state.conversationId) await newConversation(false);
  view.add('user', text);
  setBusy(true, 'Thinking');
  await audio.stop();
  try {
    const result = await api.sendMessage(state.conversationId, { message: text, voice: state.voice, interactionMode });
    view.add('assistant', result.reply.text);
    avatar.setEmotion(result.reply.emotion);
    avatar.applyGesture(result.reply.gesture);
    view.status('Speaking', 'speaking');
    await audio.playDataUrl(result.audio.data_url);
  } catch (error) {
    handleError(error, 'Reply failed');
  } finally {
    setBusy(false);
  }
}

function setBusy(value, label = null) {
  state.setBusy(value);
  view.setBusy(value);
  if (label) view.status(label, value ? 'busy' : 'ready');
}

async function toggleLiveMode() {
  if (state.liveMode) {
    stopLiveMode();
    return;
  }
  state.setLiveMode(true);
  view.setLiveMode(true);
  if (!state.conversationId) await newConversation(false);
  if (audio.playing) {
    view.status('Live after reply', 'busy');
    return;
  }
  await startLiveListening();
}

function stopLiveMode() {
  state.setLiveMode(false);
  view.setLiveMode(false);
  dom.mic.classList.remove('recording');
  if (recorder.recording) recorder.cancel();
  view.status('Ready', 'ready');
}

function scheduleLiveListening(delayMs) {
  window.setTimeout(() => {
    if (state.liveMode && !state.busy && !audio.playing && !recorder.recording) {
      startLiveListening().catch((error) => handleError(error, 'Mic error'));
    }
  }, delayMs);
}

async function startLiveListening() {
  if (!state.liveMode || state.busy || audio.playing || recorder.recording) return;
  await recorder.start({
    mode: 'live',
    autoStopOnSilence: true,
    silenceMs: 950,
    minSpeechMs: 360,
    speechThreshold: 0.035,
    idleTimeoutMs: 15000,
  });
  dom.mic.classList.add('recording');
  view.status('Listening', 'busy');
}

function handleError(error, fallback) {
  console.error(error);
  const message = error?.message || fallback;
  view.status(fallback, 'error');
  view.add('system', message);
}

boot().catch((error) => {
  console.error(error);
  view.status('Boot failed', 'error');
  view.add('system', error.message || 'Failed to start the application.');
});
