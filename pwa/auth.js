// Google Identity Services (GIS) token provider for Tab Topics PWA on mobile and web.
// Requests drive.appdata scope access and manages token expiration.

const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
let tokenClient = null;
let currentToken = null;
let tokenExpiresAt = 0;

export function loadGisScript() {
  return new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
      return resolve();
    }
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', (err) => reject(err));
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = (err) => reject(new Error('Failed to load Google Identity Services library'));
    document.head.append(s);
  });
}

export function getCachedPwaToken() {
  if (currentToken && Date.now() < tokenExpiresAt - 60000) {
    return currentToken;
  }
  // Try sessionStorage
  try {
    const raw = sessionStorage.getItem('tabTopicsGisToken');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.token && parsed.expiresAt > Date.now() + 60000) {
        currentToken = parsed.token;
        tokenExpiresAt = parsed.expiresAt;
        return currentToken;
      }
    }
  } catch {}
  return null;
}

export function saveCachedPwaToken(token, expiresInSec = 3599) {
  currentToken = token;
  tokenExpiresAt = Date.now() + expiresInSec * 1000;
  try {
    sessionStorage.setItem('tabTopicsGisToken', JSON.stringify({ token, expiresAt: tokenExpiresAt }));
  } catch {}
}

export function clearCachedPwaToken() {
  currentToken = null;
  tokenExpiresAt = 0;
  try {
    sessionStorage.removeItem('tabTopicsGisToken');
  } catch {}
}

export async function getPwaAuthToken({ interactive = false, clientId = null } = {}) {
  const cached = getCachedPwaToken();
  if (cached) return cached;

  if (!interactive) {
    return null; // Cannot prompt interactively without user gesture
  }

  await loadGisScript();

  const cid = clientId || window.TAB_TOPICS_CLIENT_ID || 'YOUR_PWA_CLIENT_ID.apps.googleusercontent.com';

  return new Promise((resolve, reject) => {
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: DEFAULT_SCOPE,
        callback: (response) => {
          if (response.error) {
            return reject(new Error(response.error_description || response.error));
          }
          if (!response.access_token) {
            return reject(new Error('No access token received from Google'));
          }
          saveCachedPwaToken(response.access_token, Number(response.expires_in) || 3599);
          resolve(response.access_token);
        },
      });

      tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (err) {
      reject(err);
    }
  });
}

export function signOutPwa() {
  if (currentToken && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
    try {
      google.accounts.oauth2.revoke(currentToken, () => {});
    } catch {}
  }
  clearCachedPwaToken();
}
