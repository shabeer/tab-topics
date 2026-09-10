import * as logic from '../shared/logic.js';
import { ensureYtMeta } from '../shared/youtube.js';
import { chromeAdapter, loadState, saveState } from '../shared/store.js';

const els = {
  curTitle: document.getElementById('cur-title'),
  topicSelect: document.getElementById('topic-select'),
  addBtn: document.getElementById('add-btn'),
  closeAfter: document.getElementById('close-after'),
  saveStatus: document.getElementById('save-status'),
  bulkToggle: document.getElementById('bulk-toggle'),
  bulkArea: document.getElementById('bulk-area'),
  bulkList: document.getElementById('bulk-list'),
  bulkApply: document.getElementById('bulk-apply'),
  bulkClose: document.getElementById('bulk-close'),
  bulkCloseAfter: document.getElementById('bulk-close-after'),
  bulkSkipAll: document.getElementById('bulk-skip-all'),
  bulkRtl: document.getElementById('bulk-rtl'),
  search: document.getElementById('search'),
  results: document.getElementById('results'),
  recent: document.getElementById('recent'),
  openManager: document.getElementById('open-manager'),
  shortcuts: document.getElementById('shortcuts-link'),
};

let state = null;
let currentTab = null;
let filedTabIds = [];
let userPickedTopicId = null; // topic the user chose manually; beats suggestions

function faviconFor(url) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Render subtitle into container: for YouTube video links, omit domain name
// and render a clickable, selectable link to the channel name.
function renderEntrySubtitle(container, entry, { topicName = null } = {}) {
  container.replaceChildren();
  const isYt = !!logic.youtubeVideoIdOf(entry.url) || !!entry.yt;
  const yt = entry.yt || (state ? logic.ytMetaFor(state, entry.url) : null);

  let hasPrefix = false;
  if (topicName) {
    container.append(document.createTextNode(topicName));
    hasPrefix = true;
  }

  if (!isYt) {
    const host = hostOf(entry.url);
    if (hasPrefix) {
      container.append(document.createTextNode(` · ${host}`));
    } else {
      container.append(document.createTextNode(host));
      hasPrefix = true;
    }
  } else if (yt && yt.channelName) {
    if (hasPrefix) {
      container.append(document.createTextNode(' · '));
    }
    const chLink = document.createElement('a');
    chLink.className = 'yt-channel-link';
    chLink.href = logic.youtubeChannelUrl(yt);
    chLink.target = '_blank';
    chLink.rel = 'noopener';
    chLink.draggable = false;
    chLink.textContent = yt.channelName;
    chLink.title = `YouTube Channel: ${yt.channelName}`;
    chLink.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      chrome.tabs.create({ url: chLink.href });
      window.close();
    });
    container.append(chLink);
    hasPrefix = true;
  }

  if (yt && yt.publishedAt) {
    const d = new Date(yt.publishedAt);
    if (!Number.isNaN(d.getTime())) {
      const pubText = `published ${d.toLocaleDateString()}`;
      container.append(document.createTextNode(hasPrefix ? ` · ${pubText}` : pubText));
    }
  }
}

function populateTopicSelect(select, targetTopicId = null) {
  select.replaceChildren();
  const suggestion = currentTab ? logic.matchUrl(state, currentTab.url) : null;
  const noTopic = logic.findTopicByName(state, 'NoTopic') || state.topics[0];
  const targetId = targetTopicId || userPickedTopicId || (suggestion ? suggestion.topicId : noTopic?.id);
  for (const topic of state.topics) {
    const opt = document.createElement('option');
    opt.value = topic.id;
    let label = topic.name;
    if (suggestion && suggestion.topicId === topic.id) label += ' — suggested';
    opt.textContent = label;
    if (topic.id === targetId) opt.selected = true;
    select.append(opt);
  }
}

function queueBadge(queue) {
  const span = document.createElement('span');
  span.className = `qbadge ${queue}`;
  span.textContent = queue === 'to_be_ordered' ? 'to order' : queue;
  return span;
}

function entryRow(entry, topicName) {
  const row = document.createElement('div');
  row.className = 'recent-item';

  const img = document.createElement('img');
  img.src = faviconFor(entry.url);
  img.alt = '';

  const body = document.createElement('div');
  body.className = 'body';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = entry.title;
  const s = document.createElement('div');
  s.className = 's';
  renderEntrySubtitle(s, entry, { topicName });
  body.append(t, s);

  row.append(img, body);
  if (entry.note) {
    const dot = document.createElement('span');
    dot.className = 'note-dot';
    dot.title = 'has note';
    dot.textContent = '✎';
    row.append(dot);
  }
  row.append(queueBadge(entry.queue));
  row.addEventListener('click', (e) => {
    if (e.target.closest('.yt-channel-link')) {
      return;
    }
    chrome.tabs.create({ url: entry.url });
    window.close();
  });
  return row;
}

function renderRecent() {
  els.recent.replaceChildren();
  const recent = [...state.entries].sort((a, b) => b.dateAdded - a.dateAdded).slice(0, 8);
  if (!recent.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'Nothing saved yet. Use the picker above or Ctrl+Shift+U.';
    els.recent.append(div);
    return;
  }
  const names = new Map(state.topics.map((t) => [t.id, t.name]));
  for (const entry of recent) els.recent.append(entryRow(entry, names.get(entry.topicId)));
}

function renderSearch() {
  const q = els.search.value;
  els.results.replaceChildren();
  if (!q.trim()) return;
  const hits = logic.searchEntries(state, q).slice(0, 8);
  if (!hits.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No matches.';
    els.results.append(div);
    return;
  }
  for (const { entry, topicName } of hits) els.results.append(entryRow(entry, topicName));
}

async function refreshCurrentTabCard() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTab = tab;
  els.curTitle.textContent = tab.title || tab.url || 'Untitled tab';
  els.curTitle.title = tab.url || '';
  populateTopicSelect(els.topicSelect);

  // Enrichment is async: the URL-based suggestion above renders instantly and
  // the match re-runs once video metadata arrives (channel rules only see the
  // Data API response). A manual user selection always wins.
  const meta = await ensureYtMeta(state, tab.url);
  if (!meta) return;
  await saveState(chromeAdapter(), state); // persist the cache fill
  if (currentTab.url === tab.url) populateTopicSelect(els.topicSelect);
}

async function afterStateChange() {
  await saveState(chromeAdapter(), state);
  renderRecent();
  renderSearch();
  try {
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' }, () => {
        if (chrome.runtime.lastError) { /* ignore if background not listening */ }
      });
    }
  } catch {
    // Ignore message passing errors
  }
}

async function init() {
  state = await loadState(chromeAdapter());
  await refreshCurrentTabCard();

  els.closeAfter.checked = !!state.settings.closeAfterAdd;
  els.closeAfter.addEventListener('change', async () => {
    state.settings.closeAfterAdd = els.closeAfter.checked;
    await saveState(chromeAdapter(), state);
  });

  els.topicSelect.addEventListener('change', () => {
    userPickedTopicId = els.topicSelect.value;
  });

  els.addBtn.addEventListener('click', async () => {
    if (!currentTab || !els.topicSelect.value) return;
    const suggestion = logic.matchUrl(state, currentTab.url);
    const meta = await ensureYtMeta(state, currentTab.url);
    const { moved } = logic.saveTab(state, currentTab, els.topicSelect.value, suggestion ? suggestion.id : null, meta);
    els.saveStatus.textContent = moved ? 'Moved to new topic (note kept)' : 'Saved ✓';
    await afterStateChange();
    if (els.closeAfter.checked) {
      try { await chrome.tabs.remove(currentTab.id); } catch { /* already gone */ }
      window.close();
    }
  });

  // --- bulk: file all tabs in this window (spec §4.2) ---
  els.bulkToggle.addEventListener('click', async () => {
    if (!els.bulkArea.hidden) {
      els.bulkArea.hidden = true;
      return;
    }
    await renderBulk();
    els.bulkArea.hidden = false;
  });

  els.bulkApply.addEventListener('click', async () => {
    const rows = [...els.bulkList.querySelectorAll('.bulk-row')];
    // Bulk rows render in tab-strip order (left to right). The insertion-order
    // checkbox reverses the processing order so rightmost tabs file first and
    // land at the top of their queues.
    const orderedRows = els.bulkRtl.checked ? [...rows].reverse() : rows;

    // Ensure metadata is fetched for YouTube URLs before topic determination and saving
    const ytUrls = orderedRows
      .map((r) => r.dataset.url)
      .filter((url) => logic.youtubeVideoIdOf(url));
    if (ytUrls.length) {
      await Promise.allSettled(ytUrls.map((url) => ensureYtMeta(state, url)));
    }

    filedTabIds = [];
    for (const row of orderedRows) {
      const tabId = Number(row.dataset.tabId);
      const select = row.querySelector('select');
      // "— skip —" (empty value) excludes the tab entirely: no entry, no close.
      if (select.value === '') continue;
      const info = { url: row.dataset.url, title: row.dataset.title };
      const suggestion = logic.matchUrl(state, info.url);
      const meta = logic.ytMetaFor(state, info.url);
      const targetTopicId =
        select.dataset.userModified === 'true'
          ? select.value
          : (suggestion ? suggestion.topicId : select.value);
      logic.saveTab(state, info, targetTopicId, suggestion ? suggestion.id : null, meta);
      filedTabIds.push(tabId);
    }
    await afterStateChange();
    if (filedTabIds.length && els.bulkCloseAfter.checked) {
      try { await chrome.tabs.remove(filedTabIds); } catch { /* some may be gone */ }
      filedTabIds = [];
      els.bulkClose.hidden = true;
      els.bulkArea.hidden = true;
      return;
    }
    els.bulkClose.hidden = filedTabIds.length === 0;
    els.bulkClose.textContent = `Close ${filedTabIds.length} filed tab${filedTabIds.length === 1 ? '' : 's'}`;
  });

  els.bulkClose.addEventListener('click', async () => {
    try { await chrome.tabs.remove(filedTabIds); } catch { /* some may be gone */ }
    filedTabIds = [];
    els.bulkClose.hidden = true;
    els.bulkArea.hidden = true;
  });

  els.bulkSkipAll.addEventListener('change', () => {
    const isSkip = els.bulkSkipAll.checked;
    const rows = els.bulkList.querySelectorAll('.bulk-row');
    for (const row of rows) {
      const select = row.querySelector('select');
      if (!select) continue;
      if (isSkip) {
        select.value = '';
        select.dataset.userModified = 'false';
      } else {
        select.dataset.userModified = 'false';
        populateBulkSelect(select, row.dataset.url);
      }
    }
  });

  els.search.addEventListener('input', renderSearch);

  els.openManager.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('page/index.html') });
    window.close();
  });
  els.shortcuts.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.tabTopicsState) {
        loadState(chromeAdapter()).then((s) => {
          state = s;
          renderRecent();
          renderSearch();
        });
      }
    });
  }

  renderRecent();
}

function populateBulkSelect(select, url, initialTopicId = null) {
  select.replaceChildren();
  const skip = document.createElement('option');
  skip.value = '';
  skip.textContent = '— skip —';
  select.append(skip);

  const suggestion = logic.matchUrl(state, url);
  const noTopic = logic.ensureTopic(state, 'NoTopic');
  const targetTopicId = initialTopicId !== null ? initialTopicId : (suggestion ? suggestion.topicId : noTopic.id);

  for (const topic of state.topics) {
    const opt = document.createElement('option');
    opt.value = topic.id;
    let label = topic.name;
    if (suggestion && suggestion.topicId === topic.id) {
      label += ' — suggested';
    }
    opt.textContent = label;
    if (topic.id === targetTopicId) {
      opt.selected = true;
    }
    select.append(opt);
  }
}

async function renderBulk() {
  els.bulkList.replaceChildren();
  els.bulkClose.hidden = true;
  if (els.bulkSkipAll) els.bulkSkipAll.checked = false;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs.filter(
    (t) => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('devtools://')
  );
  if (!candidates.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No fileable tabs in this window.';
    els.bulkList.append(div);
    return;
  }
  for (const tab of candidates) {
    const row = document.createElement('div');
    row.className = 'bulk-row';
    row.dataset.tabId = String(tab.id);
    row.dataset.url = tab.url;
    row.dataset.title = tab.title || tab.url;

    const img = document.createElement('img');
    img.src = faviconFor(tab.url);
    img.alt = '';

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = tab.title || tab.url;
    t.title = tab.url;

    const select = document.createElement('select');
    select.dataset.userModified = 'false';
    select.addEventListener('change', () => {
      select.dataset.userModified = 'true';
      if (els.bulkSkipAll) {
        const allSelects = [...els.bulkList.querySelectorAll('.bulk-row select')];
        els.bulkSkipAll.checked = allSelects.length > 0 && allSelects.every((s) => s.value === '');
      }
    });

    populateBulkSelect(select, tab.url);

    // Enrichment is async: the URL-based suggestion above renders instantly and
    // the match re-runs once video metadata arrives (channel rules only see the
    // Data API response). A manual user selection always wins.
    if (logic.youtubeVideoIdOf(tab.url)) {
      ensureYtMeta(state, tab.url).then(async (meta) => {
        if (!meta) return;
        await saveState(chromeAdapter(), state); // persist the cache fill
        if (select.dataset.userModified !== 'true' && (!els.bulkSkipAll || !els.bulkSkipAll.checked)) {
          populateBulkSelect(select, tab.url);
        }
      });
    }

    row.append(img, t, select);
    els.bulkList.append(row);
  }
}

init();
