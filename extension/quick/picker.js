// Quick picker: opened by the "save-tab" keyboard shortcut. Rules pre-select
// the suggested topic; if no rule matches, NoTopic is pre-selected. Confirming
// is the manual approval (spec §4.2) and the entry lands in that topic's
// to_be_ordered queue.

import * as logic from '../shared/logic.js';
import { ensureYtMeta } from '../shared/youtube.js';
import { chromeAdapter, loadState, saveState } from '../shared/store.js';

const tabId = Number(new URLSearchParams(location.search).get('tabId'));
const els = {
  title: document.getElementById('tab-title'),
  host: document.getElementById('tab-host'),
  filter: document.getElementById('filter'),
  list: document.getElementById('list'),
  closeAfter: document.getElementById('close-after'),
};

let tab = null;
let state = null;
let suggestion = null;
let visible = [];
let selected = 0;
let touched = false; // user has navigated/filtered — don't move their selection

function getTargetTopicId() {
  if (suggestion && state.topics.some((t) => t.id === suggestion.topicId)) {
    return suggestion.topicId;
  }
  const noTopic = logic.findTopicByName(state, 'NoTopic');
  return noTopic ? noTopic.id : (state.topics[0] ? state.topics[0].id : null);
}

async function init() {
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    els.title.textContent = 'Tab no longer exists';
    return;
  }
  state = await loadState(chromeAdapter());
  suggestion = logic.matchUrl(state, tab.url);
  els.title.textContent = tab.title || tab.url || 'Untitled tab';

  // Enrichment is async: the URL-based suggestion is live immediately, and if
  // video metadata arrives (and changes the match) the list re-renders. When
  // the user hasn't interacted yet, the selection follows the new suggestion.
  ensureYtMeta(state, tab.url).then(async (meta) => {
    if (!meta) return;
    const better = logic.matchUrl(state, tab.url);
    if (better && better.id !== (suggestion && suggestion.id)) {
      suggestion = better;
      if (!touched) {
        const idx = visible.findIndex((t) => t.id === getTargetTopicId());
        if (idx >= 0) selected = idx;
      }
    }
    await saveState(chromeAdapter(), state); // persist the cache fill
    render();
  });
  try {
    els.host.textContent = new URL(tab.url).host;
  } catch {
    els.host.textContent = tab.url || '';
  }
  els.closeAfter.checked = !!state.settings.closeAfterAdd;
  els.closeAfter.addEventListener('change', async () => {
    state.settings.closeAfterAdd = els.closeAfter.checked;
    await saveState(chromeAdapter(), state);
  });

  // Pre-select suggested topic or NoTopic
  visible = [...state.topics];
  const targetId = getTargetTopicId();
  const initialIdx = visible.findIndex((t) => t.id === targetId);
  selected = initialIdx >= 0 ? initialIdx : 0;

  render();

  els.filter.addEventListener('input', () => {
    touched = true;
    const q = els.filter.value.trim().toLowerCase();
    const newVisible = state.topics.filter((t) => t.name.toLowerCase().includes(q));
    const targetId = getTargetTopicId();
    const idx = newVisible.findIndex((t) => t.id === targetId);
    selected = idx >= 0 ? idx : 0;
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      touched = true;
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      touched = true;
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirmSelected();
    } else if (/^[1-9]$/.test(e.key) && els.filter.value === '' && document.activeElement !== els.filter) {
      e.preventDefault();
      touched = true;
      const topic = visible[Number(e.key) - 1];
      if (topic) confirm(topic.id);
    }
  });

  els.list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-topic-id]');
    if (li) {
      touched = true;
      confirm(li.dataset.topicId);
    }
  });
}

function move(delta) {
  if (!visible.length) return;
  selected = (selected + delta + visible.length) % visible.length;
  render();
}

function render() {
  const q = els.filter.value.trim().toLowerCase();
  visible = state.topics.filter((t) => t.name.toLowerCase().includes(q));
  if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
  els.list.replaceChildren();
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No matching topics';
    els.list.append(li);
    return;
  }
  visible.forEach((topic, i) => {
    const li = document.createElement('li');
    li.dataset.topicId = topic.id;
    if (i === selected) li.classList.add('selected');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = topic.name;

    li.append(idx, name);
    if (suggestion && suggestion.topicId === topic.id) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'suggested';
      li.append(badge);
    }
    els.list.append(li);
  });

  const selectedEl = els.list.children[selected];
  if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

function confirmSelected() {
  const topic = visible[selected];
  if (topic) confirm(topic.id);
}

async function confirm(topicId) {
  const meta = await ensureYtMeta(state, tab.url);
  logic.saveTab(state, tab, topicId, suggestion ? suggestion.id : null, meta);
  await saveState(chromeAdapter(), state);
  if (els.closeAfter.checked) {
    try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
  }
  window.close();
}

init();
