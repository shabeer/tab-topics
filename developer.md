# Tab Topics — Developer Documentation

Comprehensive developer guide for building, testing, validating, and extending the Tab Topics Chrome extension and companion Android Progressive Web App (PWA).

For product features, user documentation, and general overviews, see [README.md](README.md).

---

## Table of Contents

- [Getting Started & Installation](#getting-started--installation)
- [Development Workflow](#development-workflow)
- [Repository Layout & Architecture](#repository-layout--architecture)
- [Verification & Test Log](#verification--test-log)
  - [Automated Verification](#automated-verification)
  - [v2 Enhancements & Sync Verification](#v2-enhancements--sync-verification)
  - [Live Verification in Chrome](#live-verification-in-chrome)
  - [Bugs Resolved During Development](#bugs-resolved-during-development)
  - [Manual Keyboard Shortcut Verification](#manual-keyboard-shortcut-verification)
  - [Notes for Future Test Automation](#notes-for-future-test-automation)
- [Technical Specifications & References](#technical-specifications--references)

---

## Getting Started & Installation

### Install Unpacked Extension (Developer Mode)

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** via the toggle in the top-right corner.
3. Click **Load unpacked** and select the `extension/` directory of this repository.
4. The extension icon will appear in the toolbar. Click the extension or use the configured keyboard shortcuts to open its interfaces.

---

## Development Workflow

### Commands

Tab Topics uses standard Node.js tooling with zero external build dependencies:

```bash
npm test      # Run all unit tests using Node's built-in test runner (node:test)
npm run build # Validate manifest, JS syntax, HTML asset links, and module imports
npm run icons # Regenerate icons for extension and PWA (pure Node.js, no deps)
```

### Architecture Notes

- **No compilation or bundler required**: Both the Chrome extension and PWA ship as plain native ES modules (`type: "module"`).
- **Reloading changes**: When editing files in `extension/`, reload the extension in `chrome://extensions` (or use Chrome's extension reload shortcut).
- **Service Worker & Modules**: The background service worker (`background/service-worker.js`) registers alarms and listens for shortcut events. Shared data logic in `shared/` runs identically across the background worker, popup, full manager, PWA, and test runner.

---

## Repository Layout & Architecture

```
extension/
  manifest.json                 MV3 manifest (permissions: tabs, storage, favicon, identity, alarms)
  auth.js                       Chrome identity OAuth integration
  background/service-worker.js  background sync alarm + shortcut windows
  shared/logic.js               pure data logic (queues, rules, search, import)
  shared/youtube.js             YouTube Data API fetch + metadata cache orchestration
  shared/store.js               chrome.storage.local persistence (+ memory adapter for tests)
  shared/sync.js                pure 3-way merge engine + tombstone management
  shared/sync-engine.js         sync lifecycle orchestration (extension & PWA)
  shared/drive.js               Google Drive appDataFolder REST API wrapper
  popup/                        toolbar popup: quick save, bulk filing, skip-all, search, recents
  quick/                        shortcut windows: topic picker, note editor
  page/                         full-page manager: topics, 3 queues, open & delete, rules, sync settings
pwa/                            Android companion Progressive Web App
  auth.js                       Google Identity Services OAuth token client
  idb-adapter.js                IndexedDB persistence adapter
  share-receive.html / .js      Web Share Target receiver with YouTube enrichment
  index.html / .js / .css       full mobile manager UI
  sw.js                         offline service worker
  shared/                       identical shared modules matching extension/shared/
test/logic.test.js              node:test suite for the logic and YouTube enrichment layer
test/sync.test.js               node:test suite for the 3-way sync and Google Drive layer
tools/                          icon generator (gen-icons.js), build validator (validate.js)
```

---

## Verification & Test Log

This section records what was verified across build sessions, what could not be machine-tested, and the manual checklist to confirm in Chrome. Detailed spec-side notes live in [`docs/requirements-review.md`](docs/requirements-review.md) §7–§9 and [`docs/requirements_v2.md`](docs/requirements_v2.md).

### Automated Verification

All automated tests and validation passes run green:

- **79/79 unit tests pass** (`npm test`, running Node's built-in `node:test` runner across 5 suites):
  - **57 logic tests (`test/logic.test.js`)**: Topic CRUD (including delete-requires-moving-entries), NoTopic catch-all at index 0, seeding, migration, `ensureTopic` find-or-create, save-to-`to_be_ordered`, duplicate URL handling, queue transitions, reordering with clamped positions, domain/URL-pattern/YouTube-channel rule matching, first-enabled-rule-wins evaluation, disabled rules, search across notes/title/URL/topic/channel, export/import merge with local-wins conflict resolution, storage adapters, YouTube video URL parsing across all variants, `ytChannelId`/`ytChannelName` rule semantics, `ensureYtMeta` caching/tombstone/error behavior, header-based API key transport, stamping/backfill, YouTube bulk topic determination, bulk skip all tabs, and sorting YouTube videos by published date (newest/oldest toggle with undated tab stability).
  - **22 sync tests (`test/sync.test.js`)**: Unique device ID generation, Drive server clock offset calculation, record stamping, tombstone creation and 30-day pruning, LWW comparisons with deterministic tiebreaking, 3-way collection merge with concurrent edits, tombstone deletion vs edit, resurrection, full state merge with NoTopic invariant preservation, sequential queue reindexing across queues, settings sync, Google Drive REST client file creation/download/upload/error handling, full sync cycle, tab deletion sync across devices, canonical topic ID normalization across devices, and cross-device queue sorting / position reordering sync.
- **`npm run build` validation (`tools/validate.js`)**:
  - Manifest V3 syntax and permissions validation (`tabs`, `storage`, `favicon`, `identity`, `alarms`, `oauth2`).
  - Ensures all 8 manifest-referenced asset files exist.
  - Verifies that all 23 JavaScript files parse without syntax errors as ES modules.
  - Verifies that all shared modules (`logic.js`, `store.js`, `sync.js`, `drive.js`, `sync-engine.js`) import cleanly.
  - Checks that all local asset references across 6 HTML files resolve to existing files.
- **`npm run icons` (`tools/gen-icons.js`)**: Generates 16px, 48px, 128px, 192px, and 512px PNG icons dependency-free using pure Node.js and zlib.

### v2 Enhancements & Sync Verification

- **Enrichment & Sync**: YouTube metadata fetched via YouTube Data API v3, channel-based rule classification, and bidirectional cross-device sync between Chrome extension and Android PWA companion via Google Drive `appDataFolder`.
- **Deletion sync**: Deletions recorded as tombstones and synced across devices with canonical topic ID remapping.
- **Bulk filing**: Pre-fetches YouTube metadata to determine topics automatically, with "Skip all tabs" quick toggle.
- **Open & Delete**: One-click `↗✕` / `↗ Open & Delete` action opens the tab in a browser and removes it from the queue.
- **YouTube Queue Sorting**: `Sort YT ↓` / `Sort YT ↑` button in every queue moves dated YouTube videos to the top sorted by published date (newest or oldest first).

### Live Verification in Chrome (v152, macOS)

- Installed as an unpacked extension (ID `bnncfndaieaemoibgmgdmcdoakoflgdp`); enabled, service worker registered, **zero console errors**.
- **Manager page**: topics sidebar with per-topic queue counts, all three queue columns rendering, topic-creation dialog exercised end-to-end (a "News" topic was created through the real UI).
- **Persistence**: data survived extension reloads *and* a full browser quit/relaunch — the `chrome.storage.local` record is durable.
- **Quick picker page**: renders correctly when opened directly, including its "Tab no longer exists" guard for invalid tab IDs.
- **Shortcuts registered** with the intended bindings (visible at `chrome://extensions/shortcuts`).

### Bugs Resolved During Development

- **Relative URL resolution in MV3 Service Worker**: The service worker originally passed a relative URL to `chrome.windows.create`, which MV3 does not reliably resolve (there is no background page to resolve against) — the picker window would silently fail to open. Resolved by generating absolute URLs using `chrome.runtime.getURL(...)`.
- **Cross-device Topic ID Normalization**: When topics were created separately on different devices with matching names, tombstone deletion sync required canonical topic ID normalization to prevent orphan entries during 3-way merges.
- **Queue Position Resynchronization**: Queue sorting operations required batch stamping to ensure multi-item position updates synchronise cleanly without conflicting LWW timestamps.

### Manual Keyboard Shortcut Verification

Chrome's browser-level command dispatch (extension shortcuts) honors only trusted hardware input. Synthetic keyboard events cannot trigger Chrome's internal `_execute_action` or extension command dispatcher.

The manual checklist for confirming shortcuts:

1. **`⌥⇧U` (macOS) / `Alt+Shift+U` (Win/Linux)** on any web page → picker window opens; type-to-filter topics, `↑`/`↓` + `Enter` (or number keys) saves into that topic's `to_be_ordered`; "close tab after adding" is optional.
2. **`⌥⇧N` (macOS) / `Alt+Shift+N` (Win/Linux)** → note window opens; files the tab first (with a topic picker) if it is not saved yet, then allows editing the note; `⌘+Enter` / `Ctrl+Enter` saves. "Close tab after saving" checkbox is unchecked by default.
3. **`⇧⌘Space` (macOS) / `Ctrl+Shift+Space` (Win/Linux)** → popup opens: quick Add for the current tab, "File all tabs in this window" bulk filing (each tab defaults to NoTopic; rules override; "— skip —" excludes the tab; "Close tabs after filing" checkbox unchecked by default), search, recents.
4. **Manager Interactions**: Drag entries between queues or onto a sidebar topic to move cross-topic; click `Order →` / `Done ✓`; edit notes inline; add a domain rule (e.g., `example.com` → News) and reload a matching page to see the "suggested" badge pre-selected in the picker; test Settings → Export / Import JSON and Google Drive Sync.

### Notes for Future Test Automation

- Chrome 152+ blocks `--remote-debugging-port` on default profiles and restricts `--load-extension` on branded Stable builds. CDP-driven testing requires either an older Chromium build or a dedicated `--user-data-dir` with an unpacked extension.
- macOS AppleScript UI scripting via System Events is restricted for non-interactive shell processes in sandboxed environments.
- Long-running accessibility automation sessions can accumulate cached state in Chrome helpers; restarting the helper clears stale AX tree caches.

---

## Technical Specifications & References

- [`docs/requirements-review.md`](docs/requirements-review.md) — Specification and requirements review for v1 (topics, 3-queue lifecycle, rule engine, notes, and search).
- [`docs/requirements_v2.md`](docs/requirements_v2.md) — v2 specification for Google Drive 3-way sync, Android PWA Web Share Target, and YouTube Data API v3 enrichment.
- [`docs/setup_v2.md`](docs/setup_v2.md) — Guide for configuring Google Cloud Console OAuth 2.0 credentials and YouTube API keys.
- [`docs/walkthrough_v2.md`](docs/walkthrough_v2.md) — Complete end-to-end walkthrough for desktop and mobile workflows.
