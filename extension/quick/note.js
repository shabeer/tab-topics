// Quick note editor: opened by the "add-note" keyboard shortcut. If the tab
// was already saved, edits its note directly; otherwise it offers a topic
// picker first (file-then-note), since entries are only created at save time
// (spec §4.2).

import * as logic from '../shared/logic.js';
import { chromeAdapter, loadState, saveState } from '../shared/store.js';

const tabId = Number(new URLSearchParams(location.search).get('tabId'));
const els = {
  title: document.getElementById('tab-title'),
  host: document.getElementById('tab-host'),
  pickFirst: document.getElementById('pick-first'),
  topicSelect: document.getElementById('topic-select'),
  note: document.getElementById('note'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  closeAfter: document.getElementById('close-after'),
};

let tab = null;
let state = null;
let entry = null;

async function init() {
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    els.title.textContent = 'Tab no longer exists';
    els.note.disabled = true;
    els.save.disabled = true;
    return;
  }
  state = await loadState(chromeAdapter());
  entry = logic.findEntryByUrl(state, tab.url);

  els.title.textContent = tab.title || tab.url || 'Untitled tab';
  try {
    els.host.textContent = new URL(tab.url).host;
  } catch {
    els.host.textContent = tab.url || '';
  }

  if (!entry) {
    els.pickFirst.hidden = false;
    const suggestion = logic.matchUrl(state, tab.url);
    const noTopic = logic.findTopicByName(state, 'NoTopic') || state.topics[0];
    const targetTopicId = suggestion ? suggestion.topicId : noTopic?.id;
    els.topicSelect.replaceChildren();
    for (const topic of state.topics) {
      const opt = document.createElement('option');
      opt.value = topic.id;
      let label = topic.name;
      if (suggestion && suggestion.topicId === topic.id) label += ' — suggested';
      opt.textContent = label;
      if (topic.id === targetTopicId) opt.selected = true;
      els.topicSelect.append(opt);
    }
  } else {
    els.note.value = entry.note || '';
  }

  els.note.focus();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  });
  els.save.addEventListener('click', save);
}

async function save() {
  if (!entry) {
    const topicId = els.topicSelect.value;
    if (!topicId) return;
    const suggestion = logic.matchUrl(state, tab.url);
    const result = logic.saveTab(state, tab, topicId, suggestion ? suggestion.id : null);
    entry = result.entry;
  }
  logic.setNote(state, entry.id, els.note.value);
  await saveState(chromeAdapter(), state);
  if (els.closeAfter.checked) {
    try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
  }
  els.status.textContent = 'Saved ✓';
  setTimeout(() => window.close(), 450);
}

init();
