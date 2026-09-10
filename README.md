# Tab Topics — Chrome Extension & Companion PWA

A Chrome (Manifest V3) extension and companion Android Progressive Web App (PWA) that saves tabs as persistent entries, organizes them into user-defined topics through a three-stage queue system (`to_be_ordered` → `ordered` → `done`), enriches YouTube videos with channel and publish-date metadata, and synchronizes state across devices using Google Drive (`appDataFolder`).

---

## Key Features

- **Topic & Three-Queue Organization**
  - Save tabs into custom topics with a 3-stage queue workflow: `to_be_ordered` (inbox/unprioritized) → `ordered` (prioritized backlog) → `done` (completed/archive).
  - Move entries between queues manually using action buttons (`Order →`, `Done ✓`, `← Back`) or drag-and-drop within the full-page manager.
  - Drag an entry from any queue column and drop it onto a topic in the sidebar to move it cross-topic directly into `to_be_ordered`.

- **Keyboard Shortcuts** (macOS defaults shown; customizable at `chrome://extensions/shortcuts`):
  - `⌥⇧U` (`Alt+Shift+U` on Windows/Linux) — Quick Topic Picker: filter topics by typing, select with `↑`/`↓` + `Enter` or number keys; optional "Close tab after adding".
  - `⌥⇧N` (`Alt+Shift+N` on Windows/Linux) — Note Editor: add/edit notes for the active tab (automatically prompts to file the tab if unsaved); includes an optional "Close tab after saving" checkbox.
  - `⇧⌘Space` (`Ctrl+Shift+Space` on Windows/Linux) — Quick Popup: single-click save, bulk filing, live search, and recents list.

- **Full-Page Manager** (`Manager ↗` from toolbar popup):
  - 3-column queue layout proportioned at 40% : 40% : 20% (`to_be_ordered` : `ordered` : `done`) with truncated titles and full-text hover tooltips.
  - **Sort YouTube videos by published date**: Toggle `Sort YT ↓` / `Sort YT ↑` on any queue to move dated YouTube videos to the top sorted by published date (newest or oldest first) while preserving relative ordering for undated tabs.
  - **One-click Open & Delete** (`↗✕` on desktop / `↗ Open & Delete` on mobile): Opens the URL in a new browser tab and immediately removes it from the queue.
  - **Copy URL** (`⧉`): Copies the tab URL to clipboard (useful for `file://` URLs where direct opening from extension pages is restricted by Chrome).
  - Inline note editing with quick `✎` button.
  - Rules management tab with drag-and-drop rule priority reordering.
  - Settings panel for Google Drive Sync configuration, YouTube API key management, and JSON Export/Import.

- **Rule-Based Topic Classification & Suggestions**:
  - Automatically suggests topics using user-defined rules: domain matching, URL pattern wildcards (`*`), YouTube channel handle (`@handle`), YouTube channel ID (`UC...`), and YouTube channel name.
  - First enabled matching rule in list order wins (user-defined priority).
  - Manual approval workflow: suggested topics are pre-selected in save popups and bulk filing, allowing instant confirmation by pressing `Enter` or manual override.
  - Reserved **NoTopic** catch-all topic is pre-selected when no rule matches.

- **YouTube Video Enrichment**:
  - Automatically fetches video publish date, channel name, channel ID, and custom handle for supported YouTube URLs (`/watch?v=...`, `youtu.be/...`, `/shorts/...`, `/live/...`, `/embed/...`) via YouTube Data API v3 (cached per video ID).
  - Shows clickable links directly to the YouTube channel instead of generic domain names.
  - Displays formatted publish dates across manager cards, recents list, and PWA.
  - Channel name is fully searchable in live search queries.

- **Bulk Tab Filing**:
  - "File all tabs in this window" bulk interface in the extension popup.
  - Rules pre-select matching topics; unmatched tabs default to **NoTopic**; YouTube video tabs pre-fetch metadata to match channel-level rules.
  - "Skip all tabs" quick checkbox to skip or restore all rows at once.
  - "Close tabs after filing" checkbox (auto-closes filed tabs while leaving skipped tabs untouched).
  - "Insert in right-to-left tab order" checkbox to preserve tab strip visual priority.

- **Cross-Device Sync & Android Companion PWA**:
  - Bidirectional, offline-first synchronization between Chrome desktop extension and Android PWA via the user's private Google Drive `appDataFolder`.
  - Android companion PWA supports Web Share Target (save tabs from Android Chrome via the system share sheet), responsive mobile manager, and queue sorting.
  - Resolves concurrent edits using deterministic 3-way merge and tombstone-based deletion sync.

- **Live Search & Notes**:
  - Real-time substring search across note contents, tab titles, URLs, topic names, and YouTube channel names.
  - Single editable plain-text note per entry.

- **Offline-First Persistence & JSON Portability**:
  - All data is saved locally immediately (`chrome.storage.local` on desktop, `IndexedDB` on PWA) and persists across tab closures and browser restarts.
  - Export and import all data (topics, queues, entries, notes, rules, and masked settings) as a single portable JSON file with automatic merge and local-wins conflict resolution.

---

## Known Limitations

- **Channel ID and Channel Name rules match video URLs only**: Rules matching by YouTube Channel ID (`UC...`) or Channel Name evaluate against metadata fetched from video watch URLs. Direct YouTube channel landing pages (such as `youtube.com/@handle/videos`) do not contain video IDs and are matched via `@handle` rules or URL pattern rules rather than channel ID/name rules.
- **Publish-date-based filtering rules are not supported**: While YouTube publish dates are fetched, stamped on entries, and used for queue sorting (`Sort YT ↓` / `Sort YT ↑`), automated classification rules based on publish date (e.g. matching videos published within the last N days) are not supported.
- **Single-topic membership (one topic per URL)**: Entries cannot belong to multiple topics simultaneously. Saving an already-saved URL moves the entry to the new topic's `to_be_ordered` queue while preserving any existing note.
- **Topic deletion requires moving entries**: A topic cannot be deleted while it contains active entries without first selecting an existing destination topic to receive them. Any classification rules targeting the deleted topic are automatically removed.
- **Android PWA cannot close originating Chrome tab**: When saving a link to the PWA via Android's system share sheet (Web Share Target), the PWA cannot close the originating Chrome browser tab due to standard web platform security restrictions.
- **Single note per entry**: Each entry supports a single editable plain-text note rather than timestamped note history.
- **Intra-topic prioritization**: Prioritization and ordering are scoped within each topic's three queues; there are no global cross-topic priority flags or due dates.

---

## Documentation & Developer Guide

- **[developer.md](developer.md)** — Developer documentation, installation in unpacked/developer mode, test suite execution, build validation, repository layout, and verification logs.
- **[docs/setup_v2.md](docs/setup_v2.md)** — Step-by-step setup guide for Google Cloud Console OAuth 2.0 credentials and YouTube Data API keys.
- **[docs/walkthrough_v2.md](docs/walkthrough_v2.md)** — End-to-end user walkthrough of desktop extension and mobile PWA workflows.
- **[docs/requirements_v2.md](docs/requirements_v2.md)** — v2 architecture specification for cross-device sync, Android PWA, and YouTube enrichment.
- **[docs/requirements-review.md](docs/requirements-review.md)** — Baseline v1 specification, requirements review, and design decisions.
