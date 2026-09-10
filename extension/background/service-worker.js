// The service worker orchestrates keyboard commands and background periodic sync.
// Ephemeral in MV3 — persists alarms and sync state across worker restarts.

import { chromeAdapter } from '../shared/store.js';
import { performSync } from '../shared/sync-engine.js';
import { getExtensionAuthToken } from '../auth.js';

const SYNC_ALARM_NAME = 'tab-topics-periodic-sync';
const SYNC_INTERVAL_MINUTES = 2;

async function openQuickWindow(command) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) return;
  const page = command === 'add-note' ? 'quick/note.html' : 'quick/picker.html';
  await chrome.windows.create({
    url: chrome.runtime.getURL(`${page}?tabId=${tab.id}`),
    type: 'popup',
    width: 460,
    height: 560,
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'save-tab' || command === 'add-note') {
    openQuickWindow(command);
  }
});

// Setup alarm for periodic background sync
function setupSyncAlarm() {
  if (chrome.alarms && chrome.alarms.create) {
    chrome.alarms.create(SYNC_ALARM_NAME, {
      periodInMinutes: SYNC_INTERVAL_MINUTES,
    });
  }
}

async function runBackgroundSync(interactive = false) {
  try {
    await performSync({
      adapter: chromeAdapter(),
      getToken: getExtensionAuthToken,
      interactive,
    });
  } catch {
    // Silent fail in background sync
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM_NAME) {
      runBackgroundSync(false);
    }
  });
}

if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    setupSyncAlarm();
    runBackgroundSync(false);
  });
}

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    setupSyncAlarm();
    runBackgroundSync(false);
  });
}

// Allow popup and manager to trigger background sync
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'TRIGGER_SYNC') {
      runBackgroundSync(!!msg.interactive).then(() => sendResponse({ ok: true }));
      return true; // async
    }
  });
}
