// Core 3-way merge and synchronization logic for Tab Topics cross-device sync.
// Pure data logic with zero browser or network dependencies — unit-testable in Node.

import { QUEUES, ensureTopic } from './logic.js';

export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createDeviceId() {
  return 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function nowWithOffset(offsetMs = 0) {
  return Date.now() + (Number(offsetMs) || 0);
}

// Compute clock offset given server timestamp (e.g. Drive response modifiedTime or Date header)
export function computeClockOffset(serverTimeMs, localTimeMs = Date.now()) {
  if (!serverTimeMs || typeof serverTimeMs !== 'number') return 0;
  return serverTimeMs - localTimeMs;
}

// Stamp a record before local save so sync can compare versions
export function stampRecord(record, deviceId, offsetMs = 0, batchId = null) {
  if (!record || typeof record !== 'object') return record;
  record.updatedAt = nowWithOffset(offsetMs);
  record.deviceId = deviceId || 'unknown_device';
  if (batchId) {
    record.batchId = batchId;
  }
  return record;
}

// Create a tombstone for a deleted entity
export function createTombstone(id, deviceId, offsetMs = 0) {
  return {
    id: String(id),
    _deleted: true,
    deletedAt: nowWithOffset(offsetMs),
    updatedAt: nowWithOffset(offsetMs),
    deviceId: deviceId || 'unknown_device',
  };
}

export function isTombstone(item) {
  return !!(item && item._deleted === true);
}

// Prune tombstones older than maxAgeMs (default 30 days)
export function pruneTombstones(list, nowMs = Date.now(), maxAgeMs = TOMBSTONE_MAX_AGE_MS) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => {
    if (!isTombstone(item)) return true;
    const age = nowMs - (item.deletedAt || item.updatedAt || 0);
    return age < maxAgeMs;
  });
}

// Compare two versions of a record when both sides modified it.
// Returns > 0 if version A wins, < 0 if version B wins, 0 if identical.
export function compareRecordVersions(a, b) {
  const timeA = (isTombstone(a) ? a.deletedAt : a.updatedAt) || 0;
  const timeB = (isTombstone(b) ? b.deletedAt : b.updatedAt) || 0;

  if (timeA !== timeB) {
    return timeA - timeB;
  }
  // Deterministic tie-break on deviceId string comparison
  const devA = a.deviceId || '';
  const devB = b.deviceId || '';
  if (devA !== devB) {
    return devA.localeCompare(devB);
  }
  return 0;
}

// Check if a record changed compared to the base snapshot version
function isRecordModified(current, base) {
  if (!current && !base) return false;
  if (!current || !base) return true;
  if (isTombstone(current) !== isTombstone(base)) return true;

  const curTime = (isTombstone(current) ? current.deletedAt : current.updatedAt) || 0;
  const baseTime = (isTombstone(base) ? base.deletedAt : base.updatedAt) || 0;
  if (curTime !== baseTime && curTime !== 0 && baseTime !== 0) return true;

  // Shallow comparison of key fields
  const keys = new Set([...Object.keys(current), ...Object.keys(base)]);
  for (const k of keys) {
    if (k === 'updatedAt' || k === 'deviceId' || k === 'batchId') continue;
    if (JSON.stringify(current[k]) !== JSON.stringify(base[k])) return true;
  }
  return false;
}

// 3-way merge for a collection of records identified by .id
export function mergeCollection(baseList = [], localList = [], remoteList = []) {
  const baseMap = new Map((baseList || []).map((x) => [x.id, x]));
  const localMap = new Map((localList || []).map((x) => [x.id, x]));
  const remoteMap = new Map((remoteList || []).map((x) => [x.id, x]));

  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const result = [];
  let conflicts = 0;

  for (const id of allIds) {
    const base = baseMap.get(id);
    const local = localMap.get(id);
    const remote = remoteMap.get(id);

    // Case 1: Present only in one
    if (local && !remote && !base) {
      result.push(local);
      continue;
    }
    if (remote && !local && !base) {
      result.push(remote);
      continue;
    }

    // Case 2: Present in base, missing from one side (implicit deletion without tombstone)
    if (base && !local && remote) {
      if (isRecordModified(remote, base)) {
        // Remote modified it, local dropped it -> remote wins
        result.push(remote);
      }
      // Else both dropped or local dropped unchanged base -> omitted
      continue;
    }
    if (base && local && !remote) {
      if (isRecordModified(local, base)) {
        // Local modified it, remote dropped it -> local wins
        result.push(local);
      }
      // Else remote dropped unchanged base -> omitted
      continue;
    }

    // Case 3: Present in both local and remote
    if (local && remote) {
      const localChanged = isRecordModified(local, base);
      const remoteChanged = isRecordModified(remote, base);

      if (!localChanged && !remoteChanged) {
        // Neither changed -> keep either (prefer local)
        result.push(local);
      } else if (localChanged && !remoteChanged) {
        // Only local changed -> local wins
        result.push(local);
      } else if (!localChanged && remoteChanged) {
        // Only remote changed -> remote wins
        result.push(remote);
      } else {
        // Both changed -> conflict resolution via LWW + deterministic tiebreak
        conflicts++;
        const cmp = compareRecordVersions(local, remote);
        if (cmp >= 0) {
          result.push(local);
        } else {
          result.push(remote);
        }
      }
    }
  }

  return { result, conflicts };
}

// Reindex queue positions for all topics and queues
export function reindexQueues(entries, topics) {
  const activeEntries = entries.filter((e) => !isTombstone(e));
  const tombstones = entries.filter((e) => isTombstone(e));
  const validTopicIds = new Set(topics.filter((t) => !isTombstone(t)).map((t) => t.id));
  const fallbackTopicId = topics.find((t) => !isTombstone(t))?.id || 'notopic';

  // Group active entries by topicId + queue
  const groups = new Map();
  for (const entry of activeEntries) {
    if (!validTopicIds.has(entry.topicId)) {
      entry.topicId = fallbackTopicId;
    }
    const queue = QUEUES.includes(entry.queue) ? entry.queue : 'to_be_ordered';
    entry.queue = queue;
    const groupKey = `${entry.topicId}::${queue}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(entry);
  }

  for (const [, list] of groups) {
    list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    list.forEach((entry, idx) => {
      entry.position = idx;
    });
  }

  return [...activeEntries, ...tombstones];
}

// 3-way merge for complete state objects
export function mergeStates(baseSnapshot, localState, remoteState, { nowMs = Date.now() } = {}) {
  const base = JSON.parse(JSON.stringify(baseSnapshot || { topics: [], entries: [], rules: [], settings: {} }));
  const local = JSON.parse(JSON.stringify(localState || { topics: [], entries: [], rules: [], settings: {} }));
  const remote = JSON.parse(JSON.stringify(remoteState || { topics: [], entries: [], rules: [], settings: {} }));

  // 1. Merge topics
  const { result: rawTopics, conflicts: topicConflicts } = mergeCollection(
    base.topics || [],
    local.topics || [],
    remote.topics || []
  );
  let topics = pruneTombstones(rawTopics, nowMs);

  // Unify topics by case-insensitive name to prevent topic duplication across devices
  const canonicalTopics = [];
  const idRemap = new Map();

  for (const t of topics) {
    if (isTombstone(t)) {
      canonicalTopics.push(t);
      continue;
    }
    const cleanName = String(t.name || '').trim().toLowerCase();
    const existing = canonicalTopics.find(
      (x) => !isTombstone(x) && String(x.name || '').trim().toLowerCase() === cleanName
    );
    if (existing) {
      if (t.id !== existing.id) {
        idRemap.set(t.id, existing.id);
      }
    } else {
      canonicalTopics.push(t);
    }
  }

  // Also map any topic IDs present in base, local, or remote by name to their canonical topic
  const allTopicSources = [...(local.topics || []), ...(remote.topics || []), ...(base.topics || [])];
  for (const t of allTopicSources) {
    if (isTombstone(t) || !t.name) continue;
    const cleanName = String(t.name || '').trim().toLowerCase();
    const canonical = canonicalTopics.find(
      (x) => !isTombstone(x) && String(x.name || '').trim().toLowerCase() === cleanName
    );
    if (canonical && t.id !== canonical.id) {
      idRemap.set(t.id, canonical.id);
    }
  }

  // Invariant: NoTopic must exist and be at index 0 among active topics
  const activeTopics = canonicalTopics.filter((t) => !isTombstone(t));
  let noTopic = activeTopics.find((t) => t.name && t.name.toLowerCase() === 'notopic');
  if (!noTopic) {
    noTopic = {
      id: 'topic_notopic_' + Math.random().toString(36).slice(2, 8),
      name: 'NoTopic',
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    canonicalTopics.unshift(noTopic);
  } else {
    // Ensure NoTopic is at the front of the active list
    const nonTombstones = canonicalTopics.filter((t) => !isTombstone(t));
    const tombstones = canonicalTopics.filter((t) => isTombstone(t));
    const ntIdx = nonTombstones.findIndex((t) => t.id === noTopic.id);
    if (ntIdx > 0) {
      const [nt] = nonTombstones.splice(ntIdx, 1);
      nonTombstones.unshift(nt);
    }
    canonicalTopics.length = 0;
    canonicalTopics.push(...nonTombstones, ...tombstones);
  }
  topics = canonicalTopics;

  // Remap topic IDs in base, local, and remote BEFORE merging rules and entries
  for (const list of [base.rules, local.rules, remote.rules]) {
    for (const r of (list || [])) {
      if (!isTombstone(r) && idRemap.has(r.topicId)) {
        r.topicId = idRemap.get(r.topicId);
      }
    }
  }
  for (const list of [base.entries, local.entries, remote.entries]) {
    for (const e of (list || [])) {
      if (!isTombstone(e) && idRemap.has(e.topicId)) {
        e.topicId = idRemap.get(e.topicId);
      }
    }
  }

  // 2. Merge rules
  const { result: rawRules, conflicts: ruleConflicts } = mergeCollection(
    base.rules || [],
    local.rules || [],
    remote.rules || []
  );
  const rules = pruneTombstones(rawRules, nowMs);

  // 3. Merge entries
  const { result: rawEntries, conflicts: entryConflicts } = mergeCollection(
    base.entries || [],
    local.entries || [],
    remote.entries || []
  );
  let entries = pruneTombstones(rawEntries, nowMs);

  // Reindex entries across all active topics and queues
  entries = reindexQueues(entries, topics);

  // 4. Merge settings (LWW per field)
  const baseSettings = base.settings || {};
  const localSettings = local.settings || {};
  const remoteSettings = remote.settings || {};

  const localSetTime = localSettings.updatedAt || 0;
  const remoteSetTime = remoteSettings.updatedAt || 0;

  const mergedSettings = {
    closeAfterAdd:
      localSetTime >= remoteSetTime
        ? (localSettings.closeAfterAdd ?? remoteSettings.closeAfterAdd ?? false)
        : (remoteSettings.closeAfterAdd ?? localSettings.closeAfterAdd ?? false),
    // ytApiKey: take local if set, else remote if set, or newer
    ytApiKey:
      localSettings.ytApiKey && (!remoteSettings.ytApiKey || localSetTime >= remoteSetTime)
        ? localSettings.ytApiKey
        : remoteSettings.ytApiKey || localSettings.ytApiKey || '',
    updatedAt: Math.max(localSetTime, remoteSetTime, nowMs),
  };

  const totalConflicts = topicConflicts + ruleConflicts + entryConflicts;

  const mergedState = {
    schemaVersion: 1,
    topics,
    entries,
    rules,
    settings: mergedSettings,
    ytMeta: local.ytMeta || {}, // preserve local video cache
  };

  return { mergedState, conflictsCount: totalConflicts };
}

// Prepares a sanitized payload for upload to Google Drive appDataFolder
export function createSyncPayload(state, deviceId, offsetMs = 0) {
  const safeState = state || {};
  return {
    schemaVersion: 1,
    topics: (safeState.topics || []).map((t) => ({ ...t })),
    entries: (safeState.entries || []).map((e) => {
      const copy = { ...e };
      return copy;
    }),
    rules: (safeState.rules || []).map((r) => ({ ...r })),
    settings: {
      closeAfterAdd: !!(safeState.settings && safeState.settings.closeAfterAdd),
      ytApiKey: (safeState.settings && safeState.settings.ytApiKey) || '',
      updatedAt: safeState.settings?.updatedAt || nowWithOffset(offsetMs),
    },
    syncedAt: nowWithOffset(offsetMs),
    syncedByDeviceId: deviceId,
  };
}
