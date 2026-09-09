// Persistence layer. All contexts (popup, manager page, quick windows) load
// the whole state from chrome.storage.local, mutate it via shared/logic.js,
// and save it back. The adapter indirection exists so the Node test suite can
// run the same code against an in-memory map.

import { newState, ensureTopic, findTopicByName } from './logic.js';

const KEY = 'tabTopicsState';

export function chromeAdapter() {
  return {
    async get() {
      const bag = await chrome.storage.local.get(KEY);
      return bag[KEY] ?? null;
    },
    async set(value) {
      await chrome.storage.local.set({ [KEY]: value });
    },
  };
}

export function memoryAdapter(initial = null) {
  let value = initial;
  return {
    async get() {
      return value;
    },
    async set(v) {
      value = v;
    },
  };
}

export async function loadState(adapter) {
  const raw = await adapter.get();
  if (!raw || raw.schemaVersion !== 1) {
    const fresh = newState();
    await adapter.set(fresh);
    return fresh;
  }
  let dirty = false;
  // Migration: states saved before the NoTopic topic existed get it added at top.
  if (!findTopicByName(raw, 'NoTopic')) {
    ensureTopic(raw, 'NoTopic');
    dirty = true;
  }
  // Migration: states saved before YouTube enrichment existed get the
  // metadata cache and the API key slot added. Both are additive, so
  // schemaVersion stays 1 and v1 export files remain importable.
  if (!raw.settings || typeof raw.settings !== 'object') {
    raw.settings = { closeAfterAdd: false, ytApiKey: '' };
    dirty = true;
  } else if (raw.settings.ytApiKey === undefined) {
    raw.settings.ytApiKey = '';
    dirty = true;
  }
  if (!raw.ytMeta || typeof raw.ytMeta !== 'object') {
    raw.ytMeta = {};
    dirty = true;
  }
  // Ensure NoTopic is at index 0 of topics list
  const noTopicIdx = raw.topics.findIndex((t) => t.name.toLowerCase() === 'notopic');
  if (noTopicIdx > 0) {
    const [noTopic] = raw.topics.splice(noTopicIdx, 1);
    raw.topics.unshift(noTopic);
    dirty = true;
  }
  if (dirty) {
    await adapter.set(raw);
  }
  return raw;
}

export async function saveState(adapter, state) {
  await adapter.set(state);
}
