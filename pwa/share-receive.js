// Tab Topics Share Target Receiver (Android Chrome / System Share Sheet)
import * as logic from './shared/logic.js';
import { loadState, saveState } from './shared/store.js';
import { indexedDbAdapter } from './idb-adapter.js';
import { ensureYtMeta } from './shared/youtube.js';
import { loadSyncMeta, performSync } from './shared/sync-engine.js';
import { getPwaAuthToken } from './auth.js';

const adapter = indexedDbAdapter();

const els = {
  title: document.getElementById('share-title'),
  url: document.getElementById('share-url'),
  ytInfo: document.getElementById('yt-info'),
  topic: document.getElementById('share-topic'),
  note: document.getElementById('share-note'),
  form: document.getElementById('share-form'),
  saveBtn: document.getElementById('save-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  newTopicBtn: document.getElementById('new-topic-btn'),
  dlg: document.getElementById('dlg'),
  dlgForm: document.getElementById('dlg-form'),
  dlgTitle: document.getElementById('dlg-title'),
  dlgLabel: document.getElementById('dlg-label'),
  dlgInput: document.getElementById('dlg-input'),
};

let state = null;
let targetUrl = '';
let targetTitle = '';
let ytMetadata = null;
let ruleSuggestion = null;

function openDialog({ title, label, value = '' }) {
  return new Promise((resolve) => {
    if (!els.dlg) {
      const res = window.prompt(title, value);
      resolve(res ? res.trim() : null);
      return;
    }
    els.dlgTitle.textContent = title;
    els.dlgLabel.textContent = label;
    els.dlgInput.value = value;

    const onClose = () => {
      els.dlg.removeEventListener('close', onClose);
      if (els.dlg.returnValue === 'ok') {
        resolve(els.dlgInput.value.trim());
      } else {
        resolve(null);
      }
    };
    els.dlg.addEventListener('close', onClose);
    els.dlg.showModal();
    els.dlgInput.focus();
  });
}

function extractUrlFromParams() {
  const params = new URLSearchParams(window.location.search);
  let url = (params.get('url') || '').trim();
  const text = (params.get('text') || '').trim();
  let title = (params.get('title') || '').trim();

  // If url parameter is missing, search text parameter for http(s) URL
  if (!url && text) {
    const match = text.match(/https?:\/\/[^\s]+/i);
    if (match) {
      url = match[0];
      if (!title) {
        title = text.replace(match[0], '').trim();
      }
    }
  }

  if (!title) {
    title = url || 'Shared Link';
  }

  return { url, title };
}

async function init() {
  state = await loadState(adapter);
  const extracted = extractUrlFromParams();
  targetUrl = extracted.url;
  targetTitle = extracted.title;

  if (!targetUrl) {
    els.title.textContent = 'No URL received';
    els.url.textContent = 'Please share a valid link or page from Chrome.';
    els.saveBtn.disabled = true;
    return;
  }

  els.title.textContent = targetTitle;
  els.url.textContent = targetUrl;

  // Initial rule suggestion based on URL only
  ruleSuggestion = logic.matchUrl(state, targetUrl);
  populateTopics(ruleSuggestion?.topicId || state.topics[0]?.id);

  // If it's a YouTube URL, enrich via Data API if API key is present
  if (logic.youtubeVideoIdOf(targetUrl)) {
    els.ytInfo.textContent = 'Fetching YouTube info…';
    els.ytInfo.hidden = false;

    try {
      ytMetadata = await ensureYtMeta(state, targetUrl);
      if (ytMetadata) {
        els.ytInfo.textContent = `📺 ${ytMetadata.channelName || 'YouTube Video'}`;
        // Re-evaluate rules with channel metadata
        const channelSuggestion = logic.matchUrl(state, targetUrl);
        if (channelSuggestion) {
          ruleSuggestion = channelSuggestion;
          els.topic.value = channelSuggestion.topicId;
        }
      } else {
        els.ytInfo.hidden = true;
      }
    } catch {
      els.ytInfo.hidden = true;
    }
  }

  els.newTopicBtn?.addEventListener('click', async () => {
    const name = await openDialog({ title: 'New topic', label: 'Topic name' });
    if (!name) return;
    let t = logic.findTopicByName(state, name);
    if (!t) {
      t = logic.addTopic(state, name);
    }
    if (!t) return window.alert('Invalid topic name or creation failed');
    await saveState(adapter, state);
    populateTopics(t.id);
  });

  els.cancelBtn.addEventListener('click', () => {
    window.location.href = './index.html';
  });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const chosenTopicId = els.topic.value;
    if (!chosenTopicId || !targetUrl) return;

    els.saveBtn.disabled = true;
    els.saveBtn.textContent = 'Saving…';

    const { entry } = logic.saveTab(
      state,
      { url: targetUrl, title: targetTitle },
      chosenTopicId,
      ruleSuggestion?.id || null,
      ytMetadata
    );

    const noteText = els.note.value.trim();
    if (entry && noteText) {
      logic.setNote(state, entry.id, noteText);
    }

    await saveState(adapter, state);

    // Trigger sync in background
    const meta = await loadSyncMeta(adapter);
    if (meta.enabled) {
      performSync({
        adapter,
        getToken: () => getPwaAuthToken({ interactive: false }),
      }).catch(() => {});
    }

    window.location.href = './index.html';
  });
}

function populateTopics(selectedId) {
  els.topic.replaceChildren();
  for (const t of state.topics) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name + (ruleSuggestion?.topicId === t.id ? ' (suggested)' : '');
    if (t.id === selectedId) opt.selected = true;
    els.topic.append(opt);
  }
}

init();
