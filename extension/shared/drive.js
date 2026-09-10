// Google Drive v3 REST API client for Tab Topics cross-device sync.
// Handles file discovery, download, and upload within the user's hidden appDataFolder.
// Supports both Chrome extension (token via chrome.identity) and PWA (token via GIS).

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
export const SYNC_FILE_NAME = 'tabtopics-state.json';

export class DriveError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.code = code;
  }
}

function getFetch(fetchImpl) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('No fetch implementation available');
  return f;
}

// Find existing sync file in appDataFolder, or create an initial empty state file
export async function findOrCreateSyncFile(token, { fileName = SYNC_FILE_NAME, fetchImpl } = {}) {
  const f = getFetch(fetchImpl);
  const authHeader = { Authorization: `Bearer ${token}` };

  // 1. Search for existing file in appDataFolder
  const query = encodeURIComponent(`name = '${fileName}' and trashed = false`);
  const listUrl = `${DRIVE_API_BASE}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,headRevisionId,modifiedTime)&pageSize=1`;

  const listRes = await f(listUrl, { headers: authHeader });
  if (!listRes.ok) {
    throw new DriveError(`Failed to query appDataFolder: HTTP ${listRes.status}`, listRes.status);
  }

  const listData = await listRes.json().catch(() => ({}));
  if (Array.isArray(listData.files) && listData.files.length > 0) {
    const file = listData.files[0];
    return {
      id: file.id,
      name: file.name,
      headRevisionId: file.headRevisionId || null,
      modifiedTime: file.modifiedTime ? new Date(file.modifiedTime).getTime() : null,
      created: false,
    };
  }

  // 2. Not found -> create file in appDataFolder
  const createUrl = `${DRIVE_API_BASE}/files?fields=id,name,headRevisionId,modifiedTime`;
  const metadata = {
    name: fileName,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  };

  const createRes = await f(createUrl, {
    method: 'POST',
    headers: {
      ...authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  if (!createRes.ok) {
    throw new DriveError(`Failed to create sync file in appDataFolder: HTTP ${createRes.status}`, createRes.status);
  }

  const newFile = await createRes.json();
  return {
    id: newFile.id,
    name: newFile.name,
    headRevisionId: newFile.headRevisionId || null,
    modifiedTime: newFile.modifiedTime ? new Date(newFile.modifiedTime).getTime() : null,
    created: true,
  };
}

// Download the current sync payload from Google Drive
export async function downloadSyncState(token, fileId, { fetchImpl } = {}) {
  const f = getFetch(fetchImpl);
  const authHeader = { Authorization: `Bearer ${token}` };

  // Fetch file content
  const contentUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
  const metaUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,headRevisionId,modifiedTime`;

  const [contentRes, metaRes] = await Promise.all([
    f(contentUrl, { headers: authHeader }),
    f(metaUrl, { headers: authHeader }).catch(() => null),
  ]);

  if (!contentRes.ok) {
    throw new DriveError(`Failed to download sync file: HTTP ${contentRes.status}`, contentRes.status);
  }

  const data = await contentRes.json().catch(() => null);

  let headRevisionId = null;
  let modifiedTimeMs = null;

  if (metaRes && metaRes.ok) {
    const meta = await metaRes.json().catch(() => null);
    if (meta) {
      headRevisionId = meta.headRevisionId || null;
      if (meta.modifiedTime) modifiedTimeMs = new Date(meta.modifiedTime).getTime();
    }
  }

  if (!modifiedTimeMs) {
    const dateHeader = contentRes.headers.get('date') || contentRes.headers.get('last-modified');
    if (dateHeader) modifiedTimeMs = new Date(dateHeader).getTime();
  }

  return {
    data,
    headRevisionId,
    modifiedTimeMs: modifiedTimeMs || Date.now(),
  };
}

// Upload a new sync state to Google Drive using media upload
export async function uploadSyncState(token, fileId, payload, { fetchImpl } = {}) {
  const f = getFetch(fetchImpl);
  const authHeader = { Authorization: `Bearer ${token}` };

  const uploadUrl = `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,headRevisionId,modifiedTime`;
  const body = JSON.stringify(payload);

  const res = await f(uploadUrl, {
    method: 'PATCH',
    headers: {
      ...authHeader,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!res.ok) {
    throw new DriveError(`Failed to upload sync state: HTTP ${res.status}`, res.status);
  }

  const result = await res.json().catch(() => ({}));
  let modifiedTimeMs = result.modifiedTime ? new Date(result.modifiedTime).getTime() : null;
  if (!modifiedTimeMs) {
    const dateHeader = res.headers.get('date');
    if (dateHeader) modifiedTimeMs = new Date(dateHeader).getTime();
  }

  return {
    id: result.id || fileId,
    headRevisionId: result.headRevisionId || null,
    modifiedTimeMs: modifiedTimeMs || Date.now(),
  };
}
