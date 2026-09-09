// Full-page manager: topics sidebar, three drag-and-drop queues per topic
// (to_be_ordered / ordered / done), inline note editing, rules, search,
// export/import. Implements the v2 spec in docs/requirements-review.md.

import * as logic from '../shared/logic.js';
import { chromeAdapter, loadState, saveState } from '../shared/store.js';

const QUEUE_LABELS = { to_be_ordered: 'To be ordered', ordered: 'Ordered', done: 'Done' };

// Per-type hint for the rule value input in the rules panel.
const RULE_VALUE_HINTS = {
  domain: 'e.g. example.com',
  urlPattern: 'glob with * and ?, e.g. *github.com/*/pulls',
  ytChannel: 'channel handle, e.g. @veritasium',
  ytChannelId: 'channel id, e.g. UCsXVk37bltHxD1rDPwtNM8Q (case-sensitive)',
  ytChannelName: 'exact channel name, e.g. Veritasium',
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
  closeAfterSetting: document.getElementById('close-after-setting'),
  ytApiKey: document.getElementById('yt-api-key'),
  exportBtn: document.getElementById('export-btn'),
  importFile: document.getElementById('import-file'),
  shortcutsLink: document.getElementById('shortcuts-link'),
  topicList: document.getElementById('topic-list'),
  newTopic: document.getElementById('new-topic'),
  content: document.getElementById('content'),
  dlg: document.getElementById('dlg'),
  dlgTitle: document.getElementById('dlg-title'),
  dlgLabel: document.getElementById('dlg-label'),
  dlgInput: document.getElementById('dlg-input'),
  dlgSelect: document.getElementById('dlg-select'),
};

let state = null;
let selectedTopicId = null;
let searchQuery = '';
let editingEntryId = null; // note editor currently open, survives re-render

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function faviconFor(url) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Entry subtitle: channel/publish info for enriched YouTube videos.
function entrySubtitle(entry) {
  const bits = [hostOf(entry.url)];
  if (entry.yt && entry.yt.channelName) bits.push(entry.yt.channelName);
  if (entry.yt && entry.yt.publishedAt) {
    const d = new Date(entry.yt.publishedAt);
    if (!Number.isNaN(d.getTime())) bits.push(`published ${fmtDate(d.getTime())}`);
  }
  bits.push(`saved ${fmtDate(entry.dateAdded)}`);
  return bits.join(' · ');
}

async function persistAndRender() {
  await saveState(chromeAdapter(), state);
  render();
}

function openDialog({ title, label, value = '', select = null }) {
  return new Promise((resolve) => {
    els.dlgTitle.textContent = title;
    els.dlgLabel.textContent = label || '';
    if (select) {
      els.dlgInput.hidden = true;
      els.dlgSelect.hidden = false;
      els.dlgSelect.replaceChildren(
        ...select.options.map((o) => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          opt.selected = o.value === select.selected;
          return opt;
        })
      );
    } else {
      els.dlgInput.hidden = false;
      els.dlgSelect.hidden = true;
      els.dlgInput.value = value;
    }
    const onClose = () => {
      els.dlg.removeEventListener('close', onClose);
      const ok = els.dlg.returnValue === 'ok';
      resolve(ok ? (select ? els.dlgSelect.value : els.dlgInput.value.trim()) : null);
    };
    els.dlg.addEventListener('close', onClose);
    els.dlg.showModal();
    if (!select) els.dlgInput.focus();
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  if (!state.topics.some((t) => t.id === selectedTopicId)) {
    selectedTopicId = state.topics[0] ? state.topics[0].id : null;
  }
  renderSidebar();
  renderRulesPanel();
  renderSettingsPanel();
  if (searchQuery.trim()) renderSearchResults();
  else if (selectedTopicId) renderTopic();
  else els.content.replaceChildren();
}

function renderSidebar() {
  els.topicList.replaceChildren();
  for (const topic of state.topics) {
    const li = document.createElement('li');
    li.dataset.topicId = topic.id;
    if (topic.id === selectedTopicId) li.classList.add('selected');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = topic.name;

    const counts = logic.topicCounts(state, topic.id);
    const total = counts.to_be_ordered + counts.ordered + counts.done;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(total);
    count.title = `to be ordered: ${counts.to_be_ordered} · ordered: ${counts.ordered} · done: ${counts.done}`;

    const rename = document.createElement('button');
    rename.className = 'icon-btn';
    rename.textContent = '✎';
    rename.title = 'Rename topic';
    rename.addEventListener('click', (e) => { e.stopPropagation(); renameTopicFlow(topic.id, topic.name); });

    const del = document.createElement('button');
    del.className = 'icon-btn danger';
    del.textContent = '🗑';
    del.title = 'Delete topic (move entries first)';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTopicFlow(topic.id, topic.name); });

    li.append(name, count, rename, del);
    li.addEventListener('click', () => {
      selectedTopicId = topic.id;
      searchQuery = '';
      els.search.value = '';
      render();
    });

    // --- drag & drop: drop an entry card onto a sidebar topic to move it ---
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('drop-target');
      const entryId = e.dataTransfer.getData('text/plain');
      if (entryId && logic.moveEntry(state, entryId, { topicId: topic.id, queue: 'to_be_ordered' })) {
        await persistAndRender();
      }
    });

    els.topicList.append(li);
  }
}

function renderTopic() {
  const topic = state.topics.find((t) => t.id === selectedTopicId);
  els.content.replaceChildren();

  const header = document.createElement('div');
  header.className = 'topic-header';
  const h2 = document.createElement('h2');
  h2.textContent = topic.name;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.addEventListener('click', () => renameTopicFlow(topic.id, topic.name));
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => deleteTopicFlow(topic.id, topic.name));
  actions.append(renameBtn, delBtn);
  header.append(h2, actions);
  els.content.append(header);

  const queues = document.createElement('div');
  queues.className = 'queues';
  for (const queue of logic.QUEUES) queues.append(buildQueueSection(topic, queue));
  els.content.append(queues);
}

function buildQueueSection(topic, queue) {
  const section = document.createElement('section');
  section.className = 'queue';
  section.dataset.queue = queue;

  const entries = logic.entriesInQueue(state, topic.id, queue);
  const h = document.createElement('h3');
  h.append(document.createTextNode(QUEUE_LABELS[queue]));
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = String(entries.length);
  h.append(n);
  section.append(h);

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = queue === 'to_be_ordered' ? 'Nothing yet — save a tab here.' : 'Empty. Drop entries here or use the buttons.';
    section.append(empty);
  }
  for (const entry of entries) section.append(buildEntryRow(entry, queue));

  section.addEventListener('dragover', (e) => {
    e.preventDefault();
    section.classList.add('drag-over');
  });
  section.addEventListener('dragleave', () => section.classList.remove('drag-over'));
  section.addEventListener('drop', async (e) => {
    e.preventDefault();
    section.classList.remove('drag-over');
    const entryId = e.dataTransfer.getData('text/plain');
    if (entryId && logic.moveEntry(state, entryId, { queue })) await persistAndRender();
  });
  return section;
}

function buildEntryRow(entry, queue) {
  const row = document.createElement('div');
  row.className = 'entry';
  row.draggable = true;
  row.dataset.entryId = entry.id;

  const main = document.createElement('div');
  main.className = 'entry-main';

  const img = document.createElement('img');
  img.src = faviconFor(entry.url);
  img.alt = '';
  img.addEventListener('error', () => img.remove());

  const body = document.createElement('div');
  body.className = 'entry-body';
  const a = document.createElement('a');
  a.className = 't';
  a.href = entry.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = entry.title;
  a.title = entry.title; // full title on hover (truncated by CSS)
  const s = document.createElement('div');
  s.className = 's';
  s.textContent = entrySubtitle(entry);
  body.append(a, s);
  if (entry.note) {
    const np = document.createElement('div');
    np.className = 'note-preview';
    np.textContent = `✎ ${entry.note}`;
    np.title = entry.note;
    body.append(np);
  }

  const actions = document.createElement('div');
  actions.className = 'entry-actions';
  const mk = (text, title, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  };
  if (queue !== 'ordered') {
    actions.append(mk('Order →', 'Move to ordered queue', '', async () => {
      logic.moveEntry(state, entry.id, { queue: 'ordered' });
      await persistAndRender();
    }));
  }
  if (queue !== 'to_be_ordered') {
    actions.append(mk('← To order', 'Move back to to_be_ordered', '', async () => {
      logic.moveEntry(state, entry.id, { queue: 'to_be_ordered' });
      await persistAndRender();
    }));
  }
  if (queue !== 'done') {
    actions.append(mk('Done ✓', 'Move to done queue', 'done-btn', async () => {
      logic.moveEntry(state, entry.id, { queue: 'done' });
      await persistAndRender();
    }));
  }
  // Copy URL — also the workaround for file:// entries, which Chrome refuses
  // to open from an extension page unless "Allow access to file URLs" is on.
  const copyBtn = document.createElement('button');
  copyBtn.title = 'Copy URL';
  copyBtn.textContent = '⧉';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.url);
      copyBtn.textContent = '✓';
    } catch {
      copyBtn.textContent = '✕';
    }
    setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200);
  });
  actions.append(copyBtn);

  actions.append(mk('✎', 'Edit note', '', () => {
    editingEntryId = editingEntryId === entry.id ? null : entry.id;
    render();
  }));
  actions.append(mk('✕', 'Delete entry', 'del', async () => {
    if (window.confirm(`Delete "${entry.title}"?`)) {
      logic.deleteEntry(state, entry.id);
      await persistAndRender();
    }
  }));

  // Actions sit on their own row below the title/timestamp block so the
  // title gets the full card width.
  main.append(img, body);
  row.append(main);
  row.append(actions);

  if (editingEntryId === entry.id) {
    const editor = document.createElement('div');
    editor.className = 'note-edit';
    const ta = document.createElement('textarea');
    ta.value = entry.note || '';
    ta.placeholder = 'Note for this entry…';
    const btnRow = document.createElement('div');
    btnRow.className = 'row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save note';
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
    editor.append(ta, btnRow);
    row.append(editor);
    ta.focus();
  }

  // --- drag & drop: reorder within a queue / move across queues ---
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', entry.id);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.insert-above, .insert-below, .drop-target').forEach((el) => {
      el.classList.remove('insert-above', 'insert-below', 'drop-target');
    });
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    row.classList.toggle('insert-below', below);
    row.classList.toggle('insert-above', !below);
  });
  row.addEventListener('dragleave', () => row.classList.remove('insert-above', 'insert-below'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const entryId = e.dataTransfer.getData('text/plain');
    const below = row.classList.contains('insert-below');
    const list = [...row.parentElement.querySelectorAll('.entry')];
    const pos = list.indexOf(row) + (below ? 1 : 0);
    row.classList.remove('insert-above', 'insert-below');
    if (entryId && logic.moveEntry(state, entryId, { queue, position: pos })) {
      await persistAndRender();
    }
  });

  return row;
}

function renderSearchResults() {
  const hits = logic.searchEntries(state, searchQuery);
  els.content.replaceChildren();

  const h2 = document.createElement('h2');
  h2.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'} for “${searchQuery.trim()}”`;
  const clear = document.createElement('button');
  clear.className = 'linkish';
  clear.style.marginLeft = '10px';
  clear.textContent = 'clear';
  clear.addEventListener('click', () => {
    searchQuery = '';
    els.search.value = '';
    render();
  });
  h2.append(clear);
  els.content.append(h2);

  const list = document.createElement('div');
  list.className = 'results-list';
  if (!hits.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No entries match. Search covers notes, titles, URLs, and topic names.';
    list.append(p);
  }
  for (const { entry, topicName } of hits) {
    const item = document.createElement('div');
    item.className = 'search-item';

    const img = document.createElement('img');
    img.src = faviconFor(entry.url);
    img.alt = '';
    img.addEventListener('error', () => img.remove());

    const body = document.createElement('div');
    body.className = 'body';
    const a = document.createElement('a');
    a.className = 't';
    a.href = entry.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = entry.title;
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = `${topicName} · ${hostOf(entry.url)}`;
    body.append(a, s);
    if (entry.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = `✎ ${entry.note}`;
      body.append(note);
    }

    const badge = document.createElement('span');
    badge.className = `qbadge ${entry.queue}`;
    badge.textContent = entry.queue === 'to_be_ordered' ? 'to order' : entry.queue;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.title = 'Copy URL';
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.url);
        copyBtn.textContent = '✓';
      } catch {
        copyBtn.textContent = '✕';
      }
      setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200);
    });

    item.append(img, body, copyBtn, badge);
    list.append(item);
  }
  els.content.append(list);
}

// ---------------------------------------------------------------------------
// Rules panel
// ---------------------------------------------------------------------------

function renderRulesPanel() {
  els.ruleTopic.replaceChildren();
  for (const topic of state.topics) {
    const opt = document.createElement('option');
    opt.value = topic.id;
    opt.textContent = topic.name;
    els.ruleTopic.append(opt);
  }

  els.rulesBody.replaceChildren();
  if (!state.rules.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty';
    td.textContent = 'No rules yet. Rules pre-select a topic when you save a matching tab.';
    tr.append(td);
    els.rulesBody.append(tr);
    return;
  }
  for (const rule of state.rules) {
    const tr = document.createElement('tr');

    const tdType = document.createElement('td');
    const typeSel = document.createElement('select');
    for (const rt of logic.RULE_TYPES) {
      const opt = document.createElement('option');
      opt.value = rt;
      opt.textContent = rt;
      opt.selected = rt === rule.type;
      typeSel.append(opt);
    }
    typeSel.addEventListener('change', async () => {
      logic.updateRule(state, rule.id, { type: typeSel.value });
      await persistAndRender();
    });
    tdType.append(typeSel);

    const tdValue = document.createElement('td');
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value = rule.value;
    valueInput.placeholder = RULE_VALUE_HINTS[rule.type] || '';
    valueInput.title = RULE_VALUE_HINTS[rule.type] || '';
    valueInput.addEventListener('change', async () => {
      logic.updateRule(state, rule.id, { value: valueInput.value });
      await persistAndRender();
    });
    tdValue.append(valueInput);

    const tdTopic = document.createElement('td');
    const topicSel = document.createElement('select');
    for (const topic of state.topics) {
      const opt = document.createElement('option');
      opt.value = topic.id;
      opt.textContent = topic.name;
      opt.selected = topic.id === rule.topicId;
      topicSel.append(opt);
    }
    topicSel.addEventListener('change', async () => {
      logic.updateRule(state, rule.id, { topicId: topicSel.value });
      await persistAndRender();
    });
    tdTopic.append(topicSel);

    const tdEnabled = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = rule.enabled !== false;
    chk.addEventListener('change', async () => {
      logic.updateRule(state, rule.id, { enabled: chk.checked });
      await persistAndRender();
    });
    tdEnabled.append(chk);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'icon-btn danger';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      logic.deleteRule(state, rule.id);
      await persistAndRender();
    });
    tdDel.append(del);

    tr.append(tdType, tdValue, tdTopic, tdEnabled, tdDel);
    els.rulesBody.append(tr);
  }
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function renderSettingsPanel() {
  els.closeAfterSetting.checked = !!state.settings.closeAfterAdd;
  // Only reflect into the field when it isn't focused, so a render triggered
  // by another action never clobbers a key being typed.
  if (document.activeElement !== els.ytApiKey) {
    els.ytApiKey.value = state.settings.ytApiKey || '';
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function renameTopicFlow(topicId, currentName) {
  const name = await openDialog({ title: 'Rename topic', label: 'New name', value: currentName });
  if (name === null) return;
  if (!logic.renameTopic(state, topicId, name)) {
    window.alert('Could not rename: name is empty or already used by another topic.');
    return;
  }
  await persistAndRender();
}

async function deleteTopicFlow(topicId, name) {
  const others = state.topics.filter((t) => t.id !== topicId);
  if (!others.length) {
    window.alert('This is the only topic — it cannot be deleted.');
    return;
  }
  const target = await openDialog({
    title: `Delete “${name}”`,
    label: 'Move its entries to:',
    select: {
      options: others.map((t) => ({ value: t.id, label: t.name })),
      selected: others[0].id,
    },
  });
  if (target === null) return;
  const result = logic.deleteTopic(state, topicId, target);
  if (!result.ok) {
    window.alert(`Could not delete topic (${result.reason}).`);
    return;
  }
  await persistAndRender();
}

// ---------------------------------------------------------------------------
// Init & wiring
// ---------------------------------------------------------------------------

async function init() {
  state = await loadState(chromeAdapter());
  selectedTopicId = state.topics[0] ? state.topics[0].id : null;
  render();

  els.search.addEventListener('input', () => {
    searchQuery = els.search.value;
    render();
  });

  els.toggleRules.addEventListener('click', () => {
    els.rulesPanel.hidden = !els.rulesPanel.hidden;
    els.settingsPanel.hidden = true;
    els.toggleRules.classList.toggle('active', !els.rulesPanel.hidden);
    els.toggleSettings.classList.remove('active');
  });
  els.toggleSettings.addEventListener('click', () => {
    els.settingsPanel.hidden = !els.settingsPanel.hidden;
    els.rulesPanel.hidden = true;
    els.toggleSettings.classList.toggle('active', !els.settingsPanel.hidden);
    els.toggleRules.classList.remove('active');
  });

  els.newTopic.addEventListener('click', async () => {
    const name = await openDialog({ title: 'New topic', label: 'Topic name' });
    if (name === null) return;
    const topic = logic.addTopic(state, name);
    if (!topic) {
      window.alert('Could not create topic: name is empty or already exists.');
      return;
    }
    selectedTopicId = topic.id;
    await persistAndRender();
  });

  els.ruleAdd.addEventListener('click', async () => {
    const rule = logic.addRule(state, {
      type: els.ruleType.value,
      value: els.ruleValue.value,
      topicId: els.ruleTopic.value,
    });
    if (!rule) {
      window.alert('Could not add rule: pick a type, a non-empty value, and a topic.');
      return;
    }
    els.ruleValue.value = '';
    await persistAndRender();
  });

  const ruleValueHint = RULE_VALUE_HINTS[els.ruleType.value] || '';
  els.ruleValue.placeholder = ruleValueHint;
  els.ruleType.addEventListener('change', () => {
    els.ruleValue.placeholder = RULE_VALUE_HINTS[els.ruleType.value] || '';
  });

  els.closeAfterSetting.addEventListener('change', async () => {
    state.settings.closeAfterAdd = els.closeAfterSetting.checked;
    await saveState(chromeAdapter(), state);
  });

  els.ytApiKey.addEventListener('change', async () => {
    state.settings.ytApiKey = els.ytApiKey.value.trim();
    await saveState(chromeAdapter(), state);
  });

  els.exportBtn.addEventListener('click', () => {
    // Keyboard shortcuts are read from the manifest for reference; import
    // ignores them because Chrome owns the live bindings.
    const commands = chrome.runtime.getManifest().commands || {};
    const keyboardShortcuts = Object.entries(commands).map(([command, cmd]) => ({
      command,
      shortcut: cmd.suggested_key ? cmd.suggested_key.default : null,
      description: cmd.description || '',
    }));
    const data = logic.exportState(state, { keyboardShortcuts });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tab-topics-export.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files[0];
    els.importFile.value = '';
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      const stats = logic.importState(state, incoming);
      await persistAndRender();
      window.alert(
        `Imported: +${stats.topicsAdded} topic(s), +${stats.entriesAdded} entr${stats.entriesAdded === 1 ? 'y' : 'ies'}, ` +
          `+${stats.rulesAdded} rule(s). ${stats.conflictsKeptLocal} URL conflict(s) kept local.`
      );
    } catch (err) {
      window.alert(`Import failed: ${err.message}`);
    }
  });

  els.shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

init();
