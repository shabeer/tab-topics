// Chrome Extension OAuth token provider using chrome.identity API.
// Manages silent token acquisition, interactive sign-in, and cached token invalidation.

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

export async function getExtensionUserInfo() {
  if (typeof chrome === 'undefined' || !chrome.identity || !chrome.identity.getProfileUserInfo) {
    return null;
  }
  return new Promise((resolve) => {
    chrome.identity.getProfileUserInfo((info) => resolve(info || null));
  });
}
