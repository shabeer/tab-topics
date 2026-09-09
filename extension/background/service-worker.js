// The service worker only orchestrates keyboard commands: it captures the
// active tab at command time, then opens the matching quick-capture window.
// All data lives in chrome.storage.local via shared/store.js — the worker
// itself is stateless, which keeps it compatible with MV3's ephemeral workers.

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
