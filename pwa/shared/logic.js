// Pure data logic for Tab Topics. No chrome.* usage — this module is shared by
// the popup, the manager page, the quick-capture windows, and the Node test
// suite (see docs/requirements-review.md for the spec it implements).

export const QUEUES = ['to_be_ordered', 'ordered', 'done'];
export const RULE_TYPES = ['domain', 'urlPattern', 'ytChannel', 'ytChannelId', 'ytChannelName'];

export function isTombstone(item) {
  return !!(item && item._deleted === true);
}

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
    // ytMeta caches YouTube Data API results per video id so each video is
    // fetched at most once; settings.ytApiKey holds the user's own Data API
    // key (included in exportState).
    ytMeta: {},
    settings: { closeAfterAdd: false, ytApiKey: '' },
  };
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export function addTopic(state, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  if (state.topics.some((t) => !isTombstone(t) && t.name.toLowerCase() === clean.toLowerCase())) return null;
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
  return state.topics.find((t) => !isTombstone(t) && t.name.toLowerCase() === clean) || null;
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
  const topic = state.topics.find((t) => !isTombstone(t) && t.id === topicId);
  if (!topic || !clean) return false;
  if (state.topics.some((t) => !isTombstone(t) && t.id !== topicId && t.name.toLowerCase() === clean.toLowerCase())) {
    return false;
  }
  topic.name = clean;
  return true;
}

// Deleting a topic requires moving its entries to another topic first
// (spec §4.1). Rules that pointed at the deleted topic are removed.
export function deleteTopic(state, topicId, moveToTopicId) {
  if (!moveToTopicId || moveToTopicId === topicId) return { ok: false, reason: 'missing-move-target' };
  const activeTopics = state.topics.filter((t) => !isTombstone(t));
  if (activeTopics.length <= 1) return { ok: false, reason: 'last-topic' };
  if (!activeTopics.some((t) => t.id === moveToTopicId)) return { ok: false, reason: 'bad-target' };

  const moving = state.entries.filter((e) => !isTombstone(e) && e.topicId === topicId);
  for (const entry of moving) {
    entry.topicId = moveToTopicId;
    entry.position = state.entries.filter(
      (e) => !isTombstone(e) && e.topicId === moveToTopicId && e.queue === entry.queue
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
  return state.entries.find((e) => !isTombstone(e) && e.url === clean) || null;
}

function listFor(state, topicId, queue) {
  return state.entries
    .filter((e) => !isTombstone(e) && e.topicId === topicId && e.queue === queue)
    .sort((a, b) => a.position - b.position);
}

function reindex(list, batchId = null, now = Date.now()) {
  list.forEach((e, i) => {
    if (e.position !== i) {
      e.position = i;
      e.updatedAt = now;
      if (batchId) e.batchId = batchId;
    }
  });
}

export function entriesInQueue(state, topicId, queue) {
  return listFor(state, topicId, queue);
}

export function topicCounts(state, topicId) {
  const counts = { to_be_ordered: 0, ordered: 0, done: 0 };
  for (const e of state.entries) {
    if (!isTombstone(e) && e.topicId === topicId && counts[e.queue] !== undefined) counts[e.queue]++;
  }
  return counts;
}

// Saving always lands the entry in the chosen topic's to_be_ordered queue
// (spec §4.2). Re-saving a known URL moves it there, preserving its note and
// resetting its queue even if it was done (defaults #3). When video metadata
// is passed (or already cached for the URL), it is stamped onto the entry as
// `entry.yt` so channel rules, search, and export work without re-fetching.
export function saveTab(state, tab, topicId, suggestedByRuleId = null, ytMeta = null) {
  const url = normalizeUrl(tab && tab.url);
  if (!url || !state.topics.some((t) => !isTombstone(t) && t.id === topicId)) return { entry: null, moved: false };
  const meta = ytMeta || ytMetaFor(state, url);

  const existing = findEntryByUrl(state, url);
  if (existing) {
    const oldTopicId = existing.topicId;
    const oldQueue = existing.queue;
    existing.topicId = topicId;
    existing.queue = 'to_be_ordered';
    existing.position = listFor(state, topicId, 'to_be_ordered').filter((e) => e.id !== existing.id).length;
    reindex(listFor(state, oldTopicId, oldQueue).filter((e) => e.id !== existing.id));
    existing.dateAdded = Date.now();
    existing.updatedAt = Date.now();
    if (tab.title) existing.title = String(tab.title);
    existing.suggestedByRuleId = suggestedByRuleId;
    if (meta) existing.yt = ytStamp(meta);
    return { entry: existing, moved: true };
  }

  // Remove any stale tombstone for this URL if present
  state.entries = state.entries.filter((e) => !isTombstone(e) || e.url !== url);

  const now = Date.now();
  const entry = {
    id: uid(),
    url,
    title: String(tab.title || url),
    dateAdded: now,
    updatedAt: now,
    topicId,
    queue: 'to_be_ordered',
    position: listFor(state, topicId, 'to_be_ordered').length,
    note: '',
    suggestedByRuleId,
  };
  if (meta) entry.yt = ytStamp(meta);
  state.entries.push(entry);
  return { entry, moved: false };
}

// Move between queues (and optionally topics) and/or reorder within a queue.
// `position` is the insert index in the destination queue; null appends.
export function moveEntry(state, entryId, { queue = null, topicId = null, position = null } = {}) {
  const entry = state.entries.find((e) => !isTombstone(e) && e.id === entryId);
  if (!entry) return false;
  const dstQueue = queue || entry.queue;
  if (!QUEUES.includes(dstQueue)) return false;
  const dstTopic = topicId || entry.topicId;
  if (!state.topics.some((t) => !isTombstone(t) && t.id === dstTopic)) return false;

  const srcList = listFor(state, entry.topicId, entry.queue).filter((e) => e.id !== entryId);
  const dstList = listFor(state, dstTopic, dstQueue).filter((e) => e.id !== entryId);
  const idx =
    position === null || position === undefined
      ? dstList.length
      : Math.max(0, Math.min(position, dstList.length));
  dstList.splice(idx, 0, entry);

  const now = Date.now();
  const batchId = uid();

  entry.topicId = dstTopic;
  entry.queue = dstQueue;
  entry.updatedAt = now;
  entry.batchId = batchId;

  reindex(srcList, batchId, now);
  dstList.forEach((e, i) => {
    e.position = i;
    e.updatedAt = now;
    e.batchId = batchId;
  });
  return true;
}

export function setNote(state, entryId, note) {
  const entry = state.entries.find((e) => !isTombstone(e) && e.id === entryId);
  if (!entry) return false;
  entry.note = String(note ?? '');
  entry.updatedAt = Date.now();
  return true;
}

export function deleteEntry(state, entryId) {
  const entry = state.entries.find((e) => !isTombstone(e) && e.id === entryId);
  if (!entry) return false;
  state.entries = state.entries.filter((e) => e.id !== entryId);
  reindex(listFor(state, entry.topicId, entry.queue));
  return true;
}

// Sort only YouTube videos within a queue based on video published date.
// Dated YouTube videos are moved to the top (sorted by published date).
// Items without a published date (both undated YouTube videos and non-YouTube tabs)
// keep their current relative ordering after the dated videos.
export function sortQueueByYoutubePublishDate(state, topicId, queue, { ascending = false } = {}) {
  if (!QUEUES.includes(queue)) return false;
  if (!state.topics.some((t) => !isTombstone(t) && t.id === topicId)) return false;

  const currentList = listFor(state, topicId, queue);
  if (currentList.length <= 1) return true;

  const datedYt = [];
  const others = [];

  for (let i = 0; i < currentList.length; i++) {
    const entry = currentList[i];
    const isYt = !!youtubeVideoIdOf(entry.url);
    const pub = entry.yt?.publishedAt || ytMetaFor(state, entry.url)?.publishedAt;
    const ts = pub ? Date.parse(pub) : NaN;

    if (isYt && !Number.isNaN(ts)) {
      datedYt.push({ entry, ts, originalIndex: i });
    } else {
      others.push(entry);
    }
  }

  if (datedYt.length === 0) return true;

  datedYt.sort((a, b) => {
    if (a.ts !== b.ts) {
      return ascending ? a.ts - b.ts : b.ts - a.ts;
    }
    return a.originalIndex - b.originalIndex;
  });

  const reordered = [...datedYt.map((item) => item.entry), ...others];
  const now = Date.now();
  const batchId = uid();
  reordered.forEach((entry, idx) => {
    entry.position = idx;
    entry.updatedAt = now;
    entry.batchId = batchId;
  });
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
    case 'ytChannelId':
      // Channel ids are case-sensitive 24-char tokens (UC + 22); anything
      // else is rejected by returning '' (addRule/updateRule refuse it).
      return /^UC[A-Za-z0-9_-]{22}$/.test(v) ? v : '';
    case 'ytChannelName':
      return v.replace(/\s+/g, ' ');
    default:
      return v;
  }
}

export function addRule(state, { type, value, topicId }) {
  if (!RULE_TYPES.includes(type)) return null;
  if (!state.topics.some((t) => !isTombstone(t) && t.id === topicId)) return null;
  const norm = normalizeRuleValue(type, value);
  if (!norm) return null;
  const rule = { id: uid(), type, value: norm, topicId, enabled: true };
  state.rules.unshift(rule);
  return rule;
}

export function updateRule(state, ruleId, patch) {
  const rule = state.rules.find((r) => !isTombstone(r) && r.id === ruleId);
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
    if (!state.topics.some((t) => !isTombstone(t) && t.id === patch.topicId)) return false;
    rule.topicId = patch.topicId;
  }
  if (patch.enabled !== undefined) rule.enabled = !!patch.enabled;
  return true;
}

export function deleteRule(state, ruleId) {
  state.rules = state.rules.filter((r) => r.id !== ruleId);
}

// Move a rule within the list to change its matching priority (spec: first
// enabled rule in list order wins). `position` is the insert index; null appends.
export function moveRule(state, ruleId, position = null) {
  const rule = state.rules.find((r) => !isTombstone(r) && r.id === ruleId);
  if (!rule) return false;
  const list = state.rules.filter((r) => r.id !== ruleId);
  const idx =
    position === null || position === undefined
      ? list.length
      : Math.max(0, Math.min(position, list.length));
  list.splice(idx, 0, rule);
  state.rules = list;
  return true;
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

// ---------------------------------------------------------------------------
// YouTube video metadata (v2 enrichment via the Data API; see shared/youtube.js)
// ---------------------------------------------------------------------------

const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Extract the 11-char video id from any YouTube video URL shape: /watch?v=…,
// youtu.be/<id>, /shorts/<id>, /live/<id>, /embed/<id>, across youtube.com,
// m.youtube.com, and music.youtube.com. Channel URLs and anything else
// return null.
export function youtubeVideoIdOf(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1] || '';
    return YT_VIDEO_ID.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null;
  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v') || '';
    return YT_VIDEO_ID.test(id) ? id : null;
  }
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Normalize a raw metadata record (Data API response mapping or imported
// file) into the cached shape. The handle is stored the way ytHandleOf
// returns it (no leading @, lowercase) so handle rules match either source.
export function normalizeYtMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { videoId: raw.videoId ? String(raw.videoId) : undefined, fetchedAt: raw.fetchedAt || Date.now() };
  if (raw.unavailable) {
    out.unavailable = true;
    return out;
  }
  if (raw.channelId) out.channelId = String(raw.channelId);
  if (raw.channelName) out.channelName = String(raw.channelName);
  if (raw.handle) out.handle = String(raw.handle).replace(/^@/, '').toLowerCase();
  if (raw.publishedAt) out.publishedAt = String(raw.publishedAt);
  return out;
}

// The denormalized copy stored on an entry: the matching-relevant fields
// without cache bookkeeping (videoId/fetchedAt/unavailable).
export function ytStamp(meta) {
  const out = {};
  if (meta.channelId) out.channelId = meta.channelId;
  if (meta.channelName) out.channelName = meta.channelName;
  if (meta.handle) out.handle = meta.handle;
  if (meta.publishedAt) out.publishedAt = meta.publishedAt;
  return out;
}

// Cached metadata for a video URL, or null when the URL is not a video, has
// never been fetched, or the video is known-unavailable (tombstone).
export function ytMetaFor(state, url) {
  const id = youtubeVideoIdOf(url);
  if (!id) return null;
  const rec = state.ytMeta ? state.ytMeta[id] : null;
  if (!rec || rec.unavailable) return null;
  return rec;
}

// Return the channel URL for a YouTube metadata object or entry.yt.
// Prefers the handle if present (e.g. https://www.youtube.com/@handle),
// then the channelId (e.g. https://www.youtube.com/channel/UC...),
// falling back to search by channelName or the main YouTube home page.
export function youtubeChannelUrl(yt) {
  if (!yt || typeof yt !== 'object') return 'https://www.youtube.com/';
  if (yt.handle) {
    const handle = String(yt.handle).replace(/^@/, '');
    return `https://www.youtube.com/@${handle}`;
  }
  if (yt.channelId) {
    return `https://www.youtube.com/channel/${yt.channelId}`;
  }
  if (yt.channelName) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(yt.channelName)}`;
  }
  return 'https://www.youtube.com/';
}

// Keep the metadata cache bounded: past `cap` entries, drop the stalest.
export function pruneYtMeta(state, cap = 500) {
  const map = state.ytMeta;
  if (!map) return;
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  keys
    .sort((a, b) => (map[a].fetchedAt || 0) - (map[b].fetchedAt || 0))
    .slice(0, keys.length - cap)
    .forEach((k) => delete map[k]);
}

// Stamp entries whose metadata arrived after they were saved (e.g. bulk
// filing, where enrichment runs once after the whole save loop).
export function backfillYtStamps(state) {
  for (const e of state.entries) {
    if (isTombstone(e) || e.yt) continue;
    const meta = ytMetaFor(state, e.url);
    if (meta) e.yt = ytStamp(meta);
  }
}

export function ruleMatches(rule, url, meta = null) {
  if (!rule || isTombstone(rule) || rule.enabled === false) return false;
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
    const handle = ytHandleOf(u.href) || (meta ? meta.handle : null);
    return !!handle && handle === rule.value;
  }
  if (rule.type === 'ytChannelId') {
    return !!meta && !!meta.channelId && meta.channelId === rule.value;
  }
  if (rule.type === 'ytChannelName') {
    return !!meta && !!meta.channelName && meta.channelName.toLowerCase() === rule.value.toLowerCase();
  }
  return false;
}

// First enabled matching rule in list order wins (user-controlled priority).
// YouTube video URLs match channel rules through the cached metadata
// (state.ytMeta), which surfaces populate before save — see youtube.js.
export function matchUrl(state, url) {
  const meta = ytMetaFor(state, url);
  return state.rules.find((r) => !isTombstone(r) && ruleMatches(r, url, meta)) || null;
}

// ---------------------------------------------------------------------------
// Search (notes + title + URL + topic name + YouTube channel; case-insensitive
// substring)
// ---------------------------------------------------------------------------

export function searchEntries(state, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const topicName = new Map(
    state.topics.filter((t) => !isTombstone(t)).map((t) => [t.id, t.name.toLowerCase()])
  );
  return state.entries
    .filter((e) => {
      if (isTombstone(e)) return false;
      const topic = topicName.get(e.topicId) || '';
      return (
        (e.note || '').toLowerCase().includes(q) ||
        (e.title || '').toLowerCase().includes(q) ||
        (e.url || '').toLowerCase().includes(q) ||
        ((e.yt && e.yt.channelName) || '').toLowerCase().includes(q) ||
        topic.includes(q)
      );
    })
    .sort((a, b) => b.dateAdded - a.dateAdded)
    .map((e) => ({ entry: e, topicName: topicName.get(e.topicId) || '' }));
}

// Mask API key keeping only the first 4 and last 4 characters.
export function maskApiKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Export / import (merge; local wins on URL conflicts — defaults #5)
// ---------------------------------------------------------------------------

// Export the whole state as a plain JSON object. `extras.keyboardShortcuts`
// (if given) is embedded for reference only — importState ignores it, since
// bindings are owned by Chrome and cannot be applied from a file. The Data
// API key in settings is masked (first and last 4 characters preserved, middle
// characters masked). The regenerable ytMeta cache is dropped; each entry's
// stamped `yt` copy travels with the entry.
export function exportState(state, extras = {}) {
  const settings = { ...(state.settings || {}) };
  if (typeof settings.ytApiKey === 'string' && settings.ytApiKey) {
    settings.ytApiKey = maskApiKey(settings.ytApiKey);
  }
  return JSON.parse(
    JSON.stringify({
      schemaVersion: state.schemaVersion || 1,
      topics: (state.topics || []).filter((t) => !isTombstone(t)),
      entries: (state.entries || []).filter((e) => !isTombstone(e)),
      rules: (state.rules || []).filter((r) => !isTombstone(r)),
      settings,
      keyboardShortcuts: extras.keyboardShortcuts ?? null,
      exportedAt: new Date().toISOString(),
    })
  );
}

function reindexAll(state) {
  for (const topic of state.topics.filter((t) => !isTombstone(t))) {
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
  // `incoming.keyboardShortcuts` is intentionally ignored: Chrome owns the
  // actual bindings, so the exported copy is informational only.

  const stats = { topicsAdded: 0, entriesAdded: 0, conflictsKeptLocal: 0, rulesAdded: 0 };

  // Topics merge by name (case-insensitive); ids remapped for entries/rules.
  const topicMap = new Map();
  for (const t of incoming.topics) {
    if (!t || !t.name || isTombstone(t)) continue;
    const name = String(t.name).trim();
    let existing = current.topics.find((x) => !isTombstone(x) && x.name.toLowerCase() === name.toLowerCase());
    if (!existing) {
      const id = t.id && !current.topics.some((x) => x.id === t.id) ? t.id : uid();
      existing = { id, name, createdAt: t.createdAt || Date.now() };
      current.topics.push(existing);
      stats.topicsAdded++;
    }
    if (t.id) topicMap.set(t.id, existing.id);
  }

  for (const r of incoming.rules || []) {
    if (isTombstone(r)) continue;
    const topicId = r && topicMap.get(r.topicId);
    if (!topicId || !RULE_TYPES.includes(r.type) || !r.value) continue;
    const norm = normalizeRuleValue(r.type, r.value);
    if (
      current.rules.some(
        (x) => !isTombstone(x) && x.type === r.type && x.value === norm && x.topicId === topicId
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
      ...(e.yt ? { yt: ytStamp(normalizeYtMeta(e.yt) || e.yt) } : {}),
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

  // Import API key if incoming contains it and local doesn't have one set
  if (incoming.settings && typeof incoming.settings.ytApiKey === 'string' && incoming.settings.ytApiKey) {
    if (!current.settings) current.settings = { closeAfterAdd: false, ytApiKey: '' };
    if (!current.settings.ytApiKey) {
      current.settings.ytApiKey = incoming.settings.ytApiKey;
    }
  }

  reindexAll(current);
  return stats;
}
