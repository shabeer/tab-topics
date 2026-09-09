// Pure data logic for Tab Topics. No chrome.* usage — this module is shared by
// the popup, the manager page, the quick-capture windows, and the Node test
// suite (see docs/requirements-review.md for the spec it implements).

export const QUEUES = ['to_be_ordered', 'ordered', 'done'];
export const RULE_TYPES = ['domain', 'urlPattern', 'ytChannel'];

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function newState() {
  return {
    schemaVersion: 1,
    topics: [
      { id: uid(), name: 'NoTopic', createdAt: Date.now() },
      { id: uid(), name: 'General', createdAt: Date.now() },
    ],
    entries: [],
    rules: [],
    settings: { closeAfterAdd: false },
  };
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export function addTopic(state, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  if (state.topics.some((t) => t.name.toLowerCase() === clean.toLowerCase())) return null;
  const topic = { id: uid(), name: clean, createdAt: Date.now() };
  if (clean.toLowerCase() === 'notopic') {
    state.topics.unshift(topic);
  } else {
    state.topics.push(topic);
  }
  return topic;
}

export function findTopicByName(state, name) {
  const clean = String(name || '').trim().toLowerCase();
  return state.topics.find((t) => t.name.toLowerCase() === clean) || null;
}

// Find-or-create a topic by name (case-insensitive). Used for the NoTopic
// fallback target in bulk filing, which must exist even if the user deleted it.
export function ensureTopic(state, name) {
  const found = findTopicByName(state, name);
  if (found) return found;
  return addTopic(state, name);
}

export function renameTopic(state, topicId, name) {
  const clean = String(name || '').trim();
  const topic = state.topics.find((t) => t.id === topicId);
  if (!topic || !clean) return false;
  if (state.topics.some((t) => t.id !== topicId && t.name.toLowerCase() === clean.toLowerCase())) {
    return false;
  }
  topic.name = clean;
  return true;
}

// Deleting a topic requires moving its entries to another topic first
// (spec §4.1). Rules that pointed at the deleted topic are removed.
export function deleteTopic(state, topicId, moveToTopicId) {
  if (!moveToTopicId || moveToTopicId === topicId) return { ok: false, reason: 'missing-move-target' };
  if (state.topics.length <= 1) return { ok: false, reason: 'last-topic' };
  if (!state.topics.some((t) => t.id === moveToTopicId)) return { ok: false, reason: 'bad-target' };

  const moving = state.entries.filter((e) => e.topicId === topicId);
  for (const entry of moving) {
    entry.topicId = moveToTopicId;
    entry.position = state.entries.filter(
      (e) => e.topicId === moveToTopicId && e.queue === entry.queue
    ).length;
  }
  state.topics = state.topics.filter((t) => t.id !== topicId);
  state.rules = state.rules.filter((r) => r.topicId !== topicId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Entries and queues
// ---------------------------------------------------------------------------

export function normalizeUrl(url) {
  return String(url || '').trim();
}

export function findEntryByUrl(state, url) {
  const clean = normalizeUrl(url);
  return state.entries.find((e) => e.url === clean) || null;
}

function listFor(state, topicId, queue) {
  return state.entries
    .filter((e) => e.topicId === topicId && e.queue === queue)
    .sort((a, b) => a.position - b.position);
}

function reindex(list) {
  list.forEach((e, i) => {
    e.position = i;
  });
}

export function entriesInQueue(state, topicId, queue) {
  return listFor(state, topicId, queue);
}

export function topicCounts(state, topicId) {
  const counts = { to_be_ordered: 0, ordered: 0, done: 0 };
  for (const e of state.entries) {
    if (e.topicId === topicId && counts[e.queue] !== undefined) counts[e.queue]++;
  }
  return counts;
}

// Saving always lands the entry in the chosen topic's to_be_ordered queue
// (spec §4.2). Re-saving a known URL moves it there, preserving its note and
// resetting its queue even if it was done (defaults #3).
export function saveTab(state, tab, topicId, suggestedByRuleId = null) {
  const url = normalizeUrl(tab && tab.url);
  if (!url || !state.topics.some((t) => t.id === topicId)) return { entry: null, moved: false };

  const existing = findEntryByUrl(state, url);
  if (existing) {
    const oldTopicId = existing.topicId;
    const oldQueue = existing.queue;
    existing.topicId = topicId;
    existing.queue = 'to_be_ordered';
    existing.position = listFor(state, topicId, 'to_be_ordered').filter((e) => e.id !== existing.id).length;
    reindex(listFor(state, oldTopicId, oldQueue).filter((e) => e.id !== existing.id));
    existing.dateAdded = Date.now();
    if (tab.title) existing.title = String(tab.title);
    existing.suggestedByRuleId = suggestedByRuleId;
    return { entry: existing, moved: true };
  }

  const entry = {
    id: uid(),
    url,
    title: String(tab.title || url),
    dateAdded: Date.now(),
    topicId,
    queue: 'to_be_ordered',
    position: listFor(state, topicId, 'to_be_ordered').length,
    note: '',
    suggestedByRuleId,
  };
  state.entries.push(entry);
  return { entry, moved: false };
}

// Move between queues (and optionally topics) and/or reorder within a queue.
// `position` is the insert index in the destination queue; null appends.
export function moveEntry(state, entryId, { queue = null, topicId = null, position = null } = {}) {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry) return false;
  const dstQueue = queue || entry.queue;
  if (!QUEUES.includes(dstQueue)) return false;
  const dstTopic = topicId || entry.topicId;
  if (!state.topics.some((t) => t.id === dstTopic)) return false;

  const srcList = listFor(state, entry.topicId, entry.queue).filter((e) => e.id !== entryId);
  const dstList = listFor(state, dstTopic, dstQueue).filter((e) => e.id !== entryId);
  const idx =
    position === null || position === undefined
      ? dstList.length
      : Math.max(0, Math.min(position, dstList.length));
  dstList.splice(idx, 0, entry);

  entry.topicId = dstTopic;
  entry.queue = dstQueue;
  reindex(srcList);
  reindex(dstList);
  return true;
}

export function setNote(state, entryId, note) {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry) return false;
  entry.note = String(note ?? '');
  return true;
}

export function deleteEntry(state, entryId) {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry) return false;
  state.entries = state.entries.filter((e) => e.id !== entryId);
  reindex(listFor(state, entry.topicId, entry.queue));
  return true;
}

// ---------------------------------------------------------------------------
// Rules (classification suggestions)
// ---------------------------------------------------------------------------

export function normalizeRuleValue(type, value) {
  const v = String(value || '').trim();
  switch (type) {
    case 'domain':
      return v.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
    case 'ytChannel':
      return v.toLowerCase().replace(/^@/, '');
    default:
      return v;
  }
}

export function addRule(state, { type, value, topicId }) {
  if (!RULE_TYPES.includes(type)) return null;
  if (!state.topics.some((t) => t.id === topicId)) return null;
  const norm = normalizeRuleValue(type, value);
  if (!norm) return null;
  const rule = { id: uid(), type, value: norm, topicId, enabled: true };
  state.rules.push(rule);
  return rule;
}

export function updateRule(state, ruleId, patch) {
  const rule = state.rules.find((r) => r.id === ruleId);
  if (!rule) return false;
  if (patch.type !== undefined) {
    if (!RULE_TYPES.includes(patch.type)) return false;
    rule.type = patch.type;
  }
  if (patch.value !== undefined) {
    const norm = normalizeRuleValue(rule.type, patch.value);
    if (!norm) return false;
    rule.value = norm;
  }
  if (patch.topicId !== undefined) {
    if (!state.topics.some((t) => t.id === patch.topicId)) return false;
    rule.topicId = patch.topicId;
  }
  if (patch.enabled !== undefined) rule.enabled = !!patch.enabled;
  return true;
}

export function deleteRule(state, ruleId) {
  state.rules = state.rules.filter((r) => r.id !== ruleId);
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

// A YouTube channel rule can only match URLs that carry the handle/channel
// path (e.g. youtube.com/@handle/videos). Watch URLs (/watch?v=…) contain no
// channel information in v1 — see README limitations.
export function ytHandleOf(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
  const m =
    u.pathname.match(/^\/(@[A-Za-z0-9._-]+)/) ||
    u.pathname.match(/^\/(?:c|user|channel)\/([A-Za-z0-9._-]+)/);
  return m ? m[1].replace(/^@/, '').toLowerCase() : null;
}

export function ruleMatches(rule, url) {
  if (!rule || rule.enabled === false) return false;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (rule.type === 'domain') {
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    return h === rule.value || h.endsWith('.' + rule.value);
  }
  if (rule.type === 'urlPattern') {
    return globToRegex(rule.value).test(u.href);
  }
  if (rule.type === 'ytChannel') {
    const handle = ytHandleOf(u.href);
    return !!handle && handle === rule.value;
  }
  return false;
}

// First enabled matching rule in list order wins (user-controlled priority).
export function matchUrl(state, url) {
  return state.rules.find((r) => ruleMatches(r, url)) || null;
}

// ---------------------------------------------------------------------------
// Search (notes + title + URL + topic name; case-insensitive substring)
// ---------------------------------------------------------------------------

export function searchEntries(state, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const topicName = new Map(state.topics.map((t) => [t.id, t.name.toLowerCase()]));
  return state.entries
    .filter((e) => {
      const topic = topicName.get(e.topicId) || '';
      return (
        (e.note || '').toLowerCase().includes(q) ||
        (e.title || '').toLowerCase().includes(q) ||
        (e.url || '').toLowerCase().includes(q) ||
        topic.includes(q)
      );
    })
    .sort((a, b) => b.dateAdded - a.dateAdded)
    .map((e) => ({ entry: e, topicName: topicName.get(e.topicId) || '' }));
}

// ---------------------------------------------------------------------------
// Export / import (merge; local wins on URL conflicts — defaults #5)
// ---------------------------------------------------------------------------

export function exportState(state) {
  return JSON.parse(
    JSON.stringify({ ...state, exportedAt: new Date().toISOString() })
  );
}

function reindexAll(state) {
  for (const topic of state.topics) {
    for (const queue of QUEUES) {
      reindex(listFor(state, topic.id, queue));
    }
  }
}

function queueOf(e) {
  return QUEUES.includes(e.queue) ? e.queue : 'to_be_ordered';
}

export function importState(current, incoming) {
  if (
    !incoming ||
    incoming.schemaVersion !== 1 ||
    !Array.isArray(incoming.topics) ||
    !Array.isArray(incoming.entries) ||
    !Array.isArray(incoming.rules)
  ) {
    throw new Error('Unrecognized export file (expected Tab Topics schemaVersion 1)');
  }

  const stats = { topicsAdded: 0, entriesAdded: 0, conflictsKeptLocal: 0, rulesAdded: 0 };

  // Topics merge by name (case-insensitive); ids remapped for entries/rules.
  const topicMap = new Map();
  for (const t of incoming.topics) {
    if (!t || !t.name) continue;
    const name = String(t.name).trim();
    let existing = current.topics.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!existing) {
      const id = t.id && !current.topics.some((x) => x.id === t.id) ? t.id : uid();
      existing = { id, name, createdAt: t.createdAt || Date.now() };
      current.topics.push(existing);
      stats.topicsAdded++;
    }
    if (t.id) topicMap.set(t.id, existing.id);
  }

  for (const r of incoming.rules || []) {
    const topicId = r && topicMap.get(r.topicId);
    if (!topicId || !RULE_TYPES.includes(r.type) || !r.value) continue;
    const norm = normalizeRuleValue(r.type, r.value);
    if (
      current.rules.some(
        (x) => x.type === r.type && x.value === norm && x.topicId === topicId
      )
    ) {
      continue;
    }
    current.rules.push({
      id: uid(),
      type: r.type,
      value: norm,
      topicId,
      enabled: r.enabled !== false,
    });
    stats.rulesAdded++;
  }

  for (const e of incoming.entries || []) {
    const topicId = e && topicMap.get(e.topicId);
    if (!topicId || !e.url) continue;
    if (current.entries.some((x) => x.url === e.url)) {
      stats.conflictsKeptLocal++;
      continue;
    }
    const queue = queueOf(e);
    const position = current.entries.filter(
      (x) => x.topicId === topicId && x.queue === queue
    ).length;
    current.entries.push({
      id: uid(),
      url: String(e.url),
      title: String(e.title || e.url),
      dateAdded: e.dateAdded || Date.now(),
      topicId,
      queue,
      position,
      note: String(e.note || ''),
      suggestedByRuleId: null,
    });
    stats.entriesAdded++;
  }

  // Ensure NoTopic exists and is at the top
  ensureTopic(current, 'NoTopic');
  const noTopicIdx = current.topics.findIndex((t) => t.name.toLowerCase() === 'notopic');
  if (noTopicIdx > 0) {
    const [noTopic] = current.topics.splice(noTopicIdx, 1);
    current.topics.unshift(noTopic);
  }

  reindexAll(current);
  return stats;
}
