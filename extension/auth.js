// Chrome Extension OAuth token provider using chrome.identity API.
// Manages silent token acquisition, interactive sign-in, and cached token invalidation.

import { getDriveUserInfo } from './shared/drive.js';

export async function getExtensionAuthToken({ interactive = false } = {}) {
  if (typeof chrome === 'undefined' || !chrome.identity || !chrome.identity.getAuthToken) {
    throw new Error('chrome.identity API is not available in this context');
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!token) {
        return reject(new Error('User did not authorize Google Drive access'));
      }
      resolve(token);
    });
  });
}

export async function removeCachedToken(token) {
  if (typeof chrome === 'undefined' || !chrome.identity || !chrome.identity.removeCachedAuthToken) {
    return;
  }
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// Fully revoke the OAuth token on Google's servers and clear Chrome's cache.
// This ensures re-sign-in will show the Google auth prompt instead of
// silently returning a cached/remembered grant.
export async function revokeToken(token) {
  // 1. Revoke the token server-side so the OAuth grant is invalidated
  try {
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`);
  } catch {
    // Best-effort: network may be offline
  }
  // 2. Remove it from Chrome's local identity cache
  await removeCachedToken(token);
  // 3. Clear all cached auth tokens for a clean slate (MV3)
  if (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.clearAllCachedAuthTokens) {
    await chrome.identity.clearAllCachedAuthTokens();
  }
}

// Get the user info (email, displayName) of the Google account signed into the extension
// via the OAuth token, querying Google Drive API.
// Note: We avoid chrome.identity.getProfileUserInfo() because it returns the Chrome browser
// profile login email rather than the specific account the user signed into the extension with.
export async function getExtensionUserInfo(token = null) {
  let authToken = token;
  if (!authToken) {
    try {
      authToken = await getExtensionAuthToken({ interactive: false });
    } catch {
      return null;
    }
  }
  if (!authToken) return null;

  try {
    return await getDriveUserInfo(authToken);
  } catch {
    return null;
  }
}
