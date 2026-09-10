// High-level sync engine orchestrator for Tab Topics.
// Coordinates local storage, 3-way merge, and Google Drive appDataFolder REST calls.
// Works seamlessly in both Chrome Extension and PWA environments.

import { loadState, saveState } from './store.js';
import {
  createDeviceId,
  computeClockOffset,
  mergeStates,
  createSyncPayload,
  nowWithOffset,
} from './sync.js';
import { findOrCreateSyncFile, downloadSyncState, uploadSyncState } from './drive.js';

export const SYNC_META_KEY = 'tabTopicsSyncMeta';

export function defaultSyncMeta() {
  return {
    enabled: false,
    deviceId: createDeviceId(),
    clockOffsetMs: 0,
    lastSyncedAt: null,
    lastRemoteRevision: null,
    driveFileId: null,
    baseSnapshot: null,
    status: 'idle', // 'idle' | 'syncing' | 'synced' | 'error' | 'offline'
    lastError: null,
    userEmail: null,
  };
}

export async function loadSyncMeta(adapter) {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const bag = await chrome.storage.local.get(SYNC_META_KEY);
    const meta = bag[SYNC_META_KEY];
    if (meta && typeof meta === 'object') {
      return { ...defaultSyncMeta(), ...meta };
    }
  } else if (adapter && typeof adapter.get === 'function') {
    const raw = await adapter.get(SYNC_META_KEY);
    if (raw && typeof raw === 'object') {
      return { ...defaultSyncMeta(), ...raw };
    }
  }
  return defaultSyncMeta();
}

export async function saveSyncMeta(adapter, meta) {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    await chrome.storage.local.set({ [SYNC_META_KEY]: meta });
  } else if (adapter && typeof adapter.set === 'function') {
    await adapter.set(meta, SYNC_META_KEY);
  }
}

// Perform a complete sync cycle: pull -> 3-way merge -> push -> save base snapshot
export async function performSync({ adapter, getToken, fetchImpl, interactive = false }) {
  const meta = await loadSyncMeta(adapter);
  if (!meta.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  meta.status = 'syncing';
  meta.lastError = null;
  await saveSyncMeta(adapter, meta);

  let token = null;
  try {
    token = await getToken({ interactive });
  } catch (err) {
    meta.status = 'error';
    meta.lastError = err?.message || 'Authentication failed';
    await saveSyncMeta(adapter, meta);
    return { ok: false, error: meta.lastError };
  }

  if (!token) {
    meta.status = 'error';
    meta.lastError = 'No access token available';
    await saveSyncMeta(adapter, meta);
    return { ok: false, error: meta.lastError };
  }

  try {
    // 1. Locate or create sync file on Drive
    let fileInfo = null;
    if (meta.driveFileId) {
      fileInfo = { id: meta.driveFileId };
    } else {
      fileInfo = await findOrCreateSyncFile(token, { fetchImpl });
      meta.driveFileId = fileInfo.id;
    }

    // 2. Load local state
    const localState = await loadState(adapter);

    // 3. Download remote state
    let remotePayload = null;
    try {
      remotePayload = await downloadSyncState(token, fileInfo.id, { fetchImpl });
    } catch (err) {
      // If file was deleted remotely, recreate it
      if (err.status === 404) {
        fileInfo = await findOrCreateSyncFile(token, { fetchImpl });
        meta.driveFileId = fileInfo.id;
        remotePayload = { data: null, headRevisionId: null, modifiedTimeMs: Date.now() };
      } else {
        throw err;
      }
    }

    // 4. Update clock offset
    if (remotePayload && remotePayload.modifiedTimeMs) {
      meta.clockOffsetMs = computeClockOffset(remotePayload.modifiedTimeMs);
    }

    // 5. Perform 3-way merge
    const baseSnapshot = meta.baseSnapshot || null;
    const remoteData = remotePayload ? remotePayload.data : null;
    const nowMs = nowWithOffset(meta.clockOffsetMs);

    const { mergedState, conflictsCount } = mergeStates(baseSnapshot, localState, remoteData, { nowMs });

    // 6. Upload merged state to Drive
    const syncPayload = createSyncPayload(mergedState, meta.deviceId, meta.clockOffsetMs);
    const uploadRes = await uploadSyncState(token, fileInfo.id, syncPayload, { fetchImpl });

    // 7. Save merged state to local storage
    await saveState(adapter, mergedState);

    // 8. Update sync metadata
    meta.baseSnapshot = JSON.parse(JSON.stringify(mergedState));
    meta.lastSyncedAt = uploadRes.modifiedTimeMs || Date.now();
    meta.lastRemoteRevision = uploadRes.headRevisionId;
    meta.status = 'synced';
    meta.lastError = null;
    await saveSyncMeta(adapter, meta);

    return { ok: true, mergedState, conflictsCount, lastSyncedAt: meta.lastSyncedAt };
  } catch (err) {
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    meta.status = isOffline ? 'offline' : 'error';
    meta.lastError = err?.message || String(err);
    await saveSyncMeta(adapter, meta);
    return { ok: false, error: meta.lastError, isOffline };
  }
}
