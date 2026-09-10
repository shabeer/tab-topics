// Tab Topics PWA Manager
import * as logic from './shared/logic.js';
import { loadState, saveState } from './shared/store.js';
import { indexedDbAdapter } from './idb-adapter.js';
import { ensureYtMeta } from './shared/youtube.js';
import { loadSyncMeta, saveSyncMeta, performSync } from './shared/sync-engine.js';
import { getPwaAuthToken, signOutPwa, loadGisScript } from './auth.js';

const adapter = indexedDbAdapter();

let state = null;
let selectedTopicId = null;
let activeQueue = 'to_be_ordered'; // 'to_be_ordered' | 'ordered' | 'done'
let searchQuery = '';
let editingEntryId = null;
const queueSortDirections = new Map(); // topicId:queue -> 'asc' | 'desc'

const RULE_TYPE_OPTIONS = [
  { value: 'domain', label: 'Domain' },
  { value: 'urlPattern', label: 'URL pattern' },
  { value: 'ytChannelName', label: 'YTChannelName' },
  { value: 'ytChannelId', label: 'YTChannelID' },
];

const RULE_VALUE_HINTS = {
  domain: 'e.g. example.com',
  urlPattern: 'glob with * and ?, e.g. *github.com/*/pulls',
  ytChannelName: 'exact channel name, e.g. Veritasium',
  ytChannelId: 'channel id, e.g. UCsXVk37bltHxD1rDPwtNM8Q (case-sensitive)',
};

const els = {
  search: document.getElementById('global-search'),
  toggleRules: document.getElementById('toggle-rules'),
  toggleSettings: document.getElementById('toggle-settings'),
  rulesPanel: document.getElementById('rules-panel'),
  settingsPanel: document.getElementById('settings-panel'),
  rulesBody: document.getElementById('rules-body'),
  ruleType: document.getElementById('rule-type'),
  ruleValue: document.getElementById('rule-value'),
  ruleTopic: document.getElementById('rule-topic'),
  ruleAdd: document.getElementById('rule-add'),
  quickAddForm: document.getElementById('quick-add-form'),
  quickAddUrl: document.getElementById('quick-add-url'),
  quickAddTopic: document.getElementById('quick-add-topic'),
  quickAddStatus: document.getElementById('quick-add-status'),
  topicChips: document.getElementById('topic-chips'),
  newTopicBtn: document.getElementById('new-topic-btn'),
  curTopicHeading: document.getElementById('cur-topic-heading'),
  sortYtBtn: document.getElementById('sort-yt-btn'),
  renameTopicBtn: document.getElementById('rename-topic-btn'),
  deleteTopicBtn: document.getElementById('delete-topic-btn'),
  queueTabs: document.getElementById('queue-tabs'),
  countToBeOrdered: document.getElementById('count-to_be_ordered'),
  countOrdered: document.getElementById('count-ordered'),
  countDone: document.getElementById('count-done'),
  entriesContainer: document.getElementById('entries-container'),
  syncAuthBtn: document.getElementById('sync-auth-btn'),
  syncNowBtn: document.getElementById('sync-now-btn'),
  syncStatus: document.getElementById('sync-status'),
  syncDetails: document.getElementById('sync-details'),
  syncBadge: document.getElementById('sync-badge'),
  syncQuickBtn: document.getElementById('sync-quick-btn'),
  ytApiKey: document.getElementById('yt-api-key'),
  exportBtn: document.getElementById('export-btn'),
  importFile: document.getElementById('import-file'),
  dlg: document.getElementById('dlg'),
  dlgForm: document.getElementById('dlg-form'),
  dlgTitle: document.getElementById('dlg-title'),
  dlgLabel: document.getElementById('dlg-label'),
  dlgInput: document.getElementById('dlg-input'),
  dlgSelect: document.getElementById('dlg-select'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function faviconFor(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=32`;
  } catch {
    return '';
  }
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
    chLink.addEventListener('click', (e) => e.stopPropagation());
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

function openDialog({ title, label, value = '', select = null }) {
  return new Promise((resolve) => {
    els.dlgTitle.textContent = title;
    els.dlgLabel.textContent = label;
    els.dlgInput.value = value;
    if (select) {
      els.dlgSelect.replaceChildren();
      for (const opt of select.options) {
        const el = document.createElement('option');
        el.value = opt.value;
        el.textContent = opt.label;
        if (opt.value === select.selected) el.selected = true;
        els.dlgSelect.append(el);
      }
      els.dlgSelect.hidden = false;
      els.dlgInput.hidden = true;
    } else {
      els.dlgSelect.hidden = true;
      els.dlgInput.hidden = false;
    }

    const onClose = () => {
      els.dlg.removeEventListener('close', onClose);
      if (els.dlg.returnValue === 'ok') {
        resolve(select ? els.dlgSelect.value : els.dlgInput.value.trim());
      } else {
        resolve(null);
      }
    };
    els.dlg.addEventListener('close', onClose);
    els.dlg.showModal();
    if (!select) els.dlgInput.focus();
  });
}

async function persistAndRender() {
  await saveState(adapter, state);
  render();
  triggerAutoSync();
}

let syncTimeout = null;
function triggerAutoSync() {
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    const meta = await loadSyncMeta(adapter);
    if (meta.enabled) {
      performSync({
        adapter,
        getToken: () => getPwaAuthToken({ interactive: false }),
      }).then(() => updateSyncStatusUI());
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (searchQuery.trim()) {
    renderSearchResults();
    return;
  }

  const topic = state.topics.find((t) => t.id === selectedTopicId) || state.topics[0];
  if (!topic) return;
  selectedTopicId = topic.id;

  els.curTopicHeading.textContent = topic.name;
  const isNoTopic = topic.name.toLowerCase() === 'notopic';
  els.renameTopicBtn.hidden = isNoTopic;
  els.deleteTopicBtn.hidden = isNoTopic || state.topics.length <= 1;

  // Update Sort YT button label & tooltip based on active queue's sort state
  if (els.sortYtBtn) {
    const sortKey = `${selectedTopicId}:${activeQueue}`;
    const sortDirection = queueSortDirections.get(sortKey) || 'desc';
    els.sortYtBtn.textContent = sortDirection === 'asc' ? 'Sort YT ↑' : 'Sort YT ↓';
    els.sortYtBtn.title = sortDirection === 'asc'
      ? 'Sort YouTube videos by published date (oldest first, click to toggle)'
      : 'Sort YouTube videos by published date (newest first, click to toggle)';
  }

  // Render Topic Chips
  els.topicChips.replaceChildren();
  for (const t of state.topics) {
    const li = document.createElement('li');
    li.textContent = t.name;
    if (t.id === selectedTopicId) li.className = 'selected';
    li.addEventListener('click', () => {
      selectedTopicId = t.id;
      render();
    });
    els.topicChips.append(li);
  }

  // Update Queue Counts
  const counts = logic.topicCounts(state, selectedTopicId);
  els.countToBeOrdered.textContent = counts.to_be_ordered;
  els.countOrdered.textContent = counts.ordered;
  els.countDone.textContent = counts.done;

  // Highlight active queue tab
  els.queueTabs.querySelectorAll('.queue-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.queue === activeQueue);
  });

  // Render Entries for active queue
  const entries = logic.entriesInQueue(state, selectedTopicId, activeQueue);
  els.entriesContainer.replaceChildren();

  if (!entries.length) {
    const p = document.createElement('div');
    p.className = 'empty-placeholder';
    p.textContent = `No tabs in ${activeQueue.replace(/_/g, ' ')}.`;
    els.entriesContainer.append(p);
  } else {
    for (const entry of entries) {
      els.entriesContainer.append(buildEntryCard(entry));
    }
  }

  populateTopicSelects();
  renderRulesPanel();
  renderSettingsPanel();
}

function buildEntryCard(entry) {
  const card = document.createElement('div');
  card.className = 'entry-card';

  const head = document.createElement('div');
  head.className = 'entry-head';

  const img = document.createElement('img');
  img.className = 'entry-favicon';
  img.src = faviconFor(entry.url);
  img.alt = '';
  img.addEventListener('error', () => img.remove());

  const titleBox = document.createElement('div');
  titleBox.className = 'entry-title-box';

  const a = document.createElement('a');
  a.className = 'entry-link';
  a.href = entry.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = entry.title || entry.url;

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  renderEntrySubtitle(meta, entry);

  titleBox.append(a, meta);
  head.append(img, titleBox);
  card.append(head);

  if (entry.note) {
    const note = document.createElement('div');
    note.className = 'note-box';
    note.textContent = `✎ ${entry.note}`;
    card.append(note);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  };

  if (activeQueue !== 'ordered') {
    actions.append(mkBtn('Order →', 'primary', async () => {
      logic.moveEntry(state, entry.id, { queue: 'ordered' });
      await persistAndRender();
    }));
  }
  if (activeQueue !== 'to_be_ordered') {
    actions.append(mkBtn('← To order', '', async () => {
      logic.moveEntry(state, entry.id, { queue: 'to_be_ordered' });
      await persistAndRender();
    }));
  }
  if (activeQueue !== 'done') {
    actions.append(mkBtn('Done ✓', 'done-btn', async () => {
      logic.moveEntry(state, entry.id, { queue: 'done' });
      await persistAndRender();
    }));
  }

  actions.append(mkBtn('✎ Note', '', () => {
    editingEntryId = editingEntryId === entry.id ? null : entry.id;
    render();
  }));

  actions.append(mkBtn('⧉ Copy', '', async () => {
    try {
      await navigator.clipboard.writeText(entry.url);
      window.alert('URL copied to clipboard');
    } catch {}
  }));

  const openDelBtn = mkBtn('↗ Open & Delete', 'open-del-btn', async () => {
    window.open(entry.url, '_blank');
    logic.deleteEntry(state, entry.id);
    await persistAndRender();
  });
  openDelBtn.title = 'Open URL and delete entry';
  actions.append(openDelBtn);

  actions.append(mkBtn('✕ Delete', 'del-btn', async () => {
    if (window.confirm(`Delete "${entry.title}"?`)) {
      logic.deleteEntry(state, entry.id);
      await persistAndRender();
    }
  }));

  card.append(actions);

  if (editingEntryId === entry.id) {
    const editBox = document.createElement('div');
    editBox.className = 'note-edit-box';
    const ta = document.createElement('textarea');
    ta.value = entry.note || '';
    ta.placeholder = 'Add note…';
    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      logic.setNote(state, entry.id, ta.value);
      editingEntryId = null;
      await persistAndRender();
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      editingEntryId = null;
      render();
    });
    btnRow.append(saveBtn, cancelBtn);
    editBox.append(ta, btnRow);
    card.append(editBox);
    ta.focus();
  }

  return card;
}

function renderSearchResults() {
  const hits = logic.searchEntries(state, searchQuery);
  els.entriesContainer.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = `${hits.length} result(s) for “${searchQuery}”`;
  els.entriesContainer.append(title);

  if (!hits.length) {
    const p = document.createElement('div');
    p.className = 'empty-placeholder';
    p.textContent = 'No matching entries found.';
    els.entriesContainer.append(p);
    return;
  }

  for (const { entry } of hits) {
    els.entriesContainer.append(buildEntryCard(entry));
  }
}

function populateTopicSelects() {
  const selects = [els.quickAddTopic, els.ruleTopic];
  for (const sel of selects) {
    if (!sel) continue;
    const cur = sel.value;
    sel.replaceChildren();
    for (const t of state.topics) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === cur || (!cur && t.id === selectedTopicId)) opt.selected = true;
      sel.append(opt);
    }
  }
}

function renderRulesPanel() {
  els.rulesBody.replaceChildren();
  if (!state.rules.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = 'No rules created yet.';
    tr.append(td);
    els.rulesBody.append(tr);
    return;
  }

  for (const rule of state.rules) {
    const tr = document.createElement('tr');
    const targetTopic = state.topics.find((t) => t.id === rule.topicId)?.name || 'Unknown';

    const tdType = document.createElement('td');
    tdType.textContent = rule.type;
    const tdVal = document.createElement('td');
    tdVal.textContent = rule.value;
    const tdTop = document.createElement('td');
    tdTop.textContent = targetTopic;

    const tdEn = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = rule.enabled !== false;
    chk.addEventListener('change', async () => {
      logic.updateRule(state, rule.id, { enabled: chk.checked });
      await persistAndRender();
    });
    tdEn.append(chk);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'linkish danger';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      logic.deleteRule(state, rule.id);
      await persistAndRender();
    });
    tdDel.append(del);

    tr.append(tdType, tdVal, tdTop, tdEn, tdDel);
    els.rulesBody.append(tr);
  }
}

async function updateSyncStatusUI() {
  const meta = await loadSyncMeta(adapter);
  if (!els.syncStatus) return;

  els.syncStatus.className = 'sync-status-badge ' + (meta.status || 'idle');
  els.syncBadge.className = 'sync-dot ' + (meta.status || 'idle');

  if (!meta.enabled) {
    els.syncStatus.textContent = 'Disabled';
    els.syncAuthBtn.textContent = 'Sign in with Google';
    els.syncAuthBtn.className = 'primary';
    els.syncNowBtn.hidden = true;
    els.syncDetails.hidden = true;
  } else {
    els.syncAuthBtn.textContent = 'Sign out';
    els.syncAuthBtn.className = '';
    els.syncNowBtn.hidden = false;
    els.syncDetails.hidden = false;

    if (meta.status === 'syncing') {
      els.syncStatus.textContent = 'Syncing…';
    } else if (meta.status === 'synced') {
      const timeStr = meta.lastSyncedAt
        ? new Date(meta.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'recently';
      els.syncStatus.textContent = `Synced (${timeStr})`;
    } else if (meta.status === 'offline') {
      els.syncStatus.textContent = 'Offline (saved locally)';
    } else if (meta.status === 'error') {
      els.syncStatus.textContent = 'Sync error';
    } else {
      els.syncStatus.textContent = 'Active';
    }

    const details = [];
    if (meta.lastSyncedAt) {
      details.push(`Last synced: ${new Date(meta.lastSyncedAt).toLocaleString()}`);
    }
    if (meta.lastError) {
      details.push(`Error: ${meta.lastError}`);
    }
    els.syncDetails.textContent = details.join(' · ') || 'Google Drive sync active.';
  }
}

function renderSettingsPanel() {
  if (document.activeElement !== els.ytApiKey) {
    els.ytApiKey.value = state.settings.ytApiKey || '';
  }
  updateSyncStatusUI();
}

// ---------------------------------------------------------------------------
// Init & Event Listeners
// ---------------------------------------------------------------------------

async function init() {
  state = await loadState(adapter);
  selectedTopicId = state.topics[0]?.id || null;
  render();

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('PWA service worker registration failed:', err);
    });
  }

  // Search input
  els.search.addEventListener('input', () => {
    searchQuery = els.search.value;
    render();
  });

  // Queue Tabs
  els.queueTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.queue-tab');
    if (tab) {
      activeQueue = tab.dataset.queue;
      render();
    }
  });

  // Panel Toggles
  els.toggleRules.addEventListener('click', () => {
    els.rulesPanel.hidden = !els.rulesPanel.hidden;
    els.settingsPanel.hidden = true;
  });
  els.toggleSettings.addEventListener('click', () => {
    els.settingsPanel.hidden = !els.settingsPanel.hidden;
    els.rulesPanel.hidden = true;
  });
  els.syncQuickBtn.addEventListener('click', () => {
    els.settingsPanel.hidden = false;
    els.rulesPanel.hidden = true;
  });

  document.querySelectorAll('.close-panel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const p = document.getElementById(targetId);
      if (p) p.hidden = true;
    });
  });

  // Quick Add Form
  els.quickAddUrl.addEventListener('input', async () => {
    const url = els.quickAddUrl.value.trim();
    if (!url) return;
    const suggestion = logic.matchUrl(state, url);
    if (suggestion) {
      els.quickAddTopic.value = suggestion.topicId;
    }
    const meta = await ensureYtMeta(state, url);
    if (meta) {
      const refreshed = logic.matchUrl(state, url);
      if (refreshed) els.quickAddTopic.value = refreshed.topicId;
    }
  });

  els.quickAddForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = els.quickAddUrl.value.trim();
    const topicId = els.quickAddTopic.value;
    if (!url || !topicId) return;

    const suggestion = logic.matchUrl(state, url);
    const meta = await ensureYtMeta(state, url);
    logic.saveTab(state, { url, title: url }, topicId, suggestion?.id || null, meta);

    els.quickAddUrl.value = '';
    els.quickAddStatus.textContent = 'Tab saved ✓';
    els.quickAddStatus.hidden = false;
    setTimeout(() => { els.quickAddStatus.hidden = true; }, 2000);
    await persistAndRender();
  });

  // Topic Management
  els.sortYtBtn?.addEventListener('click', async () => {
    const sortKey = `${selectedTopicId}:${activeQueue}`;
    const curAsc = queueSortDirections.get(sortKey) === 'asc';
    logic.sortQueueByYoutubePublishDate(state, selectedTopicId, activeQueue, { ascending: curAsc });
    queueSortDirections.set(sortKey, curAsc ? 'desc' : 'asc');
    await persistAndRender();
  });

  els.newTopicBtn.addEventListener('click', async () => {
    const name = await openDialog({ title: 'New topic', label: 'Topic name' });
    if (!name) return;
    const t = logic.addTopic(state, name);
    if (!t) return window.alert('Topic already exists or name is invalid');
    selectedTopicId = t.id;
    await persistAndRender();
  });

  els.renameTopicBtn.addEventListener('click', async () => {
    const cur = state.topics.find((t) => t.id === selectedTopicId);
    if (!cur) return;
    const name = await openDialog({ title: 'Rename topic', label: 'New name', value: cur.name });
    if (!name) return;
    if (!logic.renameTopic(state, cur.id, name)) {
      return window.alert('Topic rename failed');
    }
    await persistAndRender();
  });

  els.deleteTopicBtn.addEventListener('click', async () => {
    const others = state.topics.filter((t) => t.id !== selectedTopicId);
    if (!others.length) return window.alert('Cannot delete the only topic');
    const targetId = await openDialog({
      title: 'Delete topic',
      label: 'Move existing entries to:',
      select: {
        options: others.map((t) => ({ value: t.id, label: t.name })),
        selected: others[0].id,
      },
    });
    if (!targetId) return;
    const res = logic.deleteTopic(state, selectedTopicId, targetId);
    if (res.ok) {
      selectedTopicId = targetId;
      await persistAndRender();
    }
  });

  // Rules
  els.ruleAdd.addEventListener('click', async () => {
    const rule = logic.addRule(state, {
      type: els.ruleType.value,
      value: els.ruleValue.value,
      topicId: els.ruleTopic.value,
    });
    if (!rule) return window.alert('Invalid rule parameters');
    els.ruleValue.value = '';
    await persistAndRender();
  });

  // Settings
  els.ytApiKey.addEventListener('change', async () => {
    state.settings.ytApiKey = els.ytApiKey.value.trim();
    await saveState(adapter, state);
  });

  els.exportBtn.addEventListener('click', () => {
    const data = logic.exportState(state);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tab-topics-export.json';
    a.click();
  });

  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files[0];
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      const stats = logic.importState(state, incoming);
      await persistAndRender();
      window.alert(`Import complete: +${stats.topicsAdded} topics, +${stats.entriesAdded} entries.`);
    } catch (err) {
      window.alert(`Import failed: ${err.message}`);
    }
  });

  // Sync Auth
  els.syncAuthBtn.addEventListener('click', async () => {
    const meta = await loadSyncMeta(adapter);
    if (meta.enabled) {
      meta.enabled = false;
      meta.status = 'idle';
      signOutPwa();
      await saveSyncMeta(adapter, meta);
      await updateSyncStatusUI();
    } else {
      els.syncStatus.textContent = 'Signing in…';
      try {
        const token = await getPwaAuthToken({ interactive: true });
        if (token) {
          meta.enabled = true;
          await saveSyncMeta(adapter, meta);
          await updateSyncStatusUI();
          const res = await performSync({
            adapter,
            getToken: () => getPwaAuthToken({ interactive: false }),
          });
          if (res.ok) {
            state = await loadState(adapter);
            render();
          }
          await updateSyncStatusUI();
        }
      } catch (err) {
        window.alert(`Sign-in failed: ${err.message}`);
        await updateSyncStatusUI();
      }
    }
  });

  els.syncNowBtn.addEventListener('click', async () => {
    els.syncStatus.textContent = 'Syncing…';
    const res = await performSync({
      adapter,
      getToken: () => getPwaAuthToken({ interactive: true }),
      interactive: true,
    });
    if (res.ok) {
      state = await loadState(adapter);
      render();
    } else {
      window.alert(`Sync failed: ${res.error || 'Unknown error'}`);
    }
    await updateSyncStatusUI();
  });

  // Auto-sync on visibility change / app return
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadState(adapter).then((fresh) => {
        state = fresh;
        render();
        triggerAutoSync();
      });
    }
  });
}

init();
