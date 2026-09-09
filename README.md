# Tab Topics — Chrome extension

A Chrome (Manifest V3) extension that saves open tabs as persistent entries,
files them under user-defined topics through three per-topic queues
(`to_be_ordered` → `ordered` → `done`), and supports per-entry notes, search,
and JSON export/import. Built to the revised specification in
[`docs/requirements-review.md`](docs/requirements-review.md).

## Features

- **Save current tab to a topic** — everything lands in the topic's
  `to_be_ordered` queue; you move it to `ordered` or `done` manually
  (buttons or drag-and-drop in the manager). In the manager, you can also
  drag an entry card from any queue column and drop it onto a topic in the
  sidebar to move it to that topic's `to_be_ordered` queue.
- **Keyboard shortcuts** (macOS chords — note that manifest "Ctrl" maps to ⌘ Command on Mac)
  - `⌥⇧U` (default) — quick picker: filter topics by typing, pick with ↑↓ + Enter
    or number keys, optional "close tab after adding".
  - `⌥⇧N` — add/edit the note on the current tab (files the tab first if it
    isn't saved yet). "Close tab after saving" checkbox, unchecked by default.
  - `⇧⌘Space` — open popup: quick Add, "File all tabs in this window", search
  - On Windows/Linux the defaults are `Alt+Shift+U` / `Alt+Shift+N` /
    `Ctrl+Shift+Space`. All bindings are suggestions; customize them at
    `chrome://extensions/shortcuts`.
- **Manager** (toolbar icon → Manager ↗): 
  - Three queue columns laid out 40% : 40% : 20% of the width
    (to be ordered : ordered : done); long titles and notes are truncated with
    an ellipsis and shown in full on hover
  - ⧉ button on each entry (and search result) copies its URL to the clipboard
    — the way to grab the address of a `file://` entry, which Chrome refuses to
    open from an extension page unless "Allow access to file URLs" is enabled
  - Drag entries between queues, or drag onto a sidebar topic to move cross-topic
  - Order →, Done ✓ buttons
  - Rules tab (try domain rule example.com → News, then reload example.com and see the "suggested" badge in the picker; drag and drop rows to reorder rule priority) 
  - Settings → Export

- **Rule-based topic suggestions** — domain, URL-pattern (`*` wildcards),
  YouTube-channel-handle, YouTube-channel-id, and YouTube-channel-name rules
  pre-select a topic in the quick picker and bulk filing. Drag-and-drop
  reordering in the manager sets evaluation priority (first enabled match
  wins). If no rules match, **NoTopic** is pre-selected. In the save tab
  popup, simply pressing Enter saves to the pre-selected topic (manual
  approval).
- **YouTube video enrichment** — for `/watch?v=…`, `youtu.be/…`, `/shorts/…`,
  `/live/…`, and `/embed/…` links, the extension fetches the video's publish
  date, channel name, and channel id once (YouTube Data API v3, cached per
  video) and stamps them on the entry. Channel-id and channel-name rules can
  then classify watch URLs, recents/manager show the channel and publish date,
  and search covers the channel name. Requires a free Data API key pasted into
  the manager's Settings (included in export JSON in masked form). Without a
  key, everything works exactly as before on URL rules alone.
- **Bulk filing** — "File all tabs in this window" in the popup: one topic
  select per tab (rules pre-select matching topics; unmatched tabs default to
  **NoTopic**). Tabs marked "— skip —" are excluded entirely — no entry, no close.
  An unchecked-by-default "Close tabs after filing" checkbox auto-closes all
  filed (non-skipped) tabs when checked. A separate manual "Close filed tabs"
  button remains available when the auto-close checkbox is off. An unchecked-by-default
  "Insert in right-to-left tab order" checkbox controls the order entries land in
  their queues: unchecked (default) files the tabs left to right, checked files
  right to left so the rightmost tab gets the top position in its queue.
- **NoTopic catch-all** — a reserved topic at the top of the topics list.
  Bulk filing and the quick picker default to it when no rule matches. If deleted,
  it is silently recreated at the top on next load.
- **Notes** — one editable plain-text note per entry. You can write/edit notes
  inline in the full-page manager (with ✎ button) or via the `⌥⇧N` quick-capture
  window (which lets you choose a topic first if the tab isn't saved yet, and
  includes an optional "Close tab after saving" checkbox).
- **Search** — live search facility available in both the popup and manager page.
  Searches across custom notes, tab titles, URLs, and topic names (newest first).
- **Export / Import** — export all plugin data (topics, entries with notes/queues/positions,
  rules, settings) to a single JSON file. The file also embeds a reference copy of the
  keyboard shortcuts (read from the manifest); importing ignores it, since Chrome owns the
  live bindings. Importing merges topics by name, remaps IDs, deduplicates rules, keeps
  local notes on same-URL conflicts, and reports summary stats.
- **Persistent** — entries live in `chrome.storage.local` and survive tab
  closes and browser restarts. Closing a tab never deletes its entry.

## Install (unpacked, developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` directory of this repo.

## Development

```bash
npm test      # unit tests for the logic/storage layer (node:test)
npm run build # validation: manifest, JS syntax, asset references
npm run icons # regenerate extension/icons/*.png (pure Node, no deps)
```

No build step or bundler is needed — the extension ships plain ES modules.
Reload the extension in `chrome://extensions` after editing files.

### Layout

```
extension/
  manifest.json               MV3 manifest (permissions: tabs, storage, favicon;
                              host permissions: googleapis.com for YouTube enrichment)
  background/service-worker.js  opens quick-capture windows on shortcuts
  shared/logic.js             pure data logic (queues, rules, search, import)
  shared/youtube.js           YouTube Data API fetch + metadata cache orchestration
  shared/store.js             chrome.storage.local persistence (+ memory adapter for tests)
  popup/                      toolbar popup: quick save, bulk filing, search, recents
  quick/                      shortcut windows: topic picker, note editor
  page/                       full-page manager: topics, 3 queues, drag & drop, rules, settings
test/logic.test.js            node:test suite for the logic layer
tools/                        icon generator, build validator
```

## Verification & test log (from the build session)

This section records what was verified while building the extension, what
could not be machine-tested and why, and the short checklist to confirm by
hand. The spec-side view of the same information lives in
[`docs/requirements-review.md`](docs/requirements-review.md) §7.

### Automated verification — all green

- **29/29 unit tests pass** (`npm test`, Node's built-in runner). Coverage:
  topic CRUD (including delete-requires-moving-entries), NoTopic at the top,
  seeding, migration (recreated at top if missing), `ensureTopic` find-or-create,
  save-to-`to_be_ordered`, duplicate handling (note kept, queue reset even
  from `done`), all queue moves, reordering with clamped positions,
  domain/URL-pattern/YouTube-channel rule matching, first-enabled-rule-wins,
  disabled rules, search across notes/title/URL/topic, export/import merge
  with local-wins conflicts, and the storage adapters.
- **`npm run build` validates**: MV3 manifest parses, every manifest-referenced
  asset exists, all JS files parse as ES modules, every HTML-referenced local
  asset resolves, shared modules import cleanly and behave.
- Icons are generated dependency-free by `npm run icons`.

### v2 session — YouTube enrichment

- **51/51 unit tests pass** (`npm test`): the 28 v1 tests plus 23 covering
  video-URL shape parsing (`/watch`, `youtu.be`, `/shorts`, `/live`,
  `/embed`, music/m hosts), `ytChannelId`/`ytChannelName` rule semantics and
  validation, handle rules matching through fetched metadata, `ensureYtMeta`
  caching/tombstone/error behavior (injected fetch, no network; key sent via
  `X-Goog-Api-Key` header), entry stamping + bulk backfill, export/import key
  masking and hygiene, the `loadState` migration for pre-v2 states, and
  channel-name search.
- **`npm run build` validates** with the new `shared/youtube.js` module and
  the `host_permissions` entry.
- To verify by hand: reload the extension (Chrome will show the new
  "read and change your data on www.googleapis.com" permission), save a
  `youtu.be/…` link without a key (v1 behavior, no enrichment), then paste a
  Data API key in the manager's Settings and save the link again — the entry
  subtitle shows the channel and publish date, and a `ytChannelName` rule for
  that channel pre-selects its topic on the next save.

### Verified live in Chrome (v152, macOS)

- Installed as an unpacked extension (ID `bnncfndaieaemoibgmgdmcdoakoflgdp`);
  enabled, service worker registered, **zero console errors**.
- **Manager page**: topics sidebar with per-topic queue counts, all three
  queue columns rendering, topic-creation dialog exercised end-to-end
  (a "News" topic was created through the real UI).
- **Persistence**: data survived extension reloads *and* a full browser
  quit/relaunch — the `chrome.storage.local` record is durable.
- **Quick picker page**: renders correctly when opened directly, including its
  "Tab no longer exists" guard for invalid tab ids.
- **Shortcuts registered** with the intended bindings (visible at
  `chrome://extensions/shortcuts`).

### Bug found and fixed during verification

The service worker originally passed a **relative** URL to
`chrome.windows.create`, which MV3 does not reliably resolve (there is no
background page to resolve against) — the picker window would silently fail
to open. Fixed by building absolute URLs with `chrome.runtime.getURL(...)`.
If you forked an older copy of this repo, make sure you have that fix.

### Why the keyboard chords could not be machine-tested

Chrome's browser-level command dispatch (extension shortcuts) only honors
trusted hardware input. This was proven, not assumed: with a clean Chrome
restart and the chord delivered to the confirmed frontmost window, neither
⇧⌘U nor ⇧⌘Space fired — and ⇧⌘Space invokes `_execute_action`, which is
Chrome's own native handler with none of this extension's code involved.
Conclusion: it is an input-trust limitation of synthetic keyboard events, not
an extension defect. The chords are the one item to confirm by hand:

1. **⌥⇧U** on any web page → picker window opens; type-to-filter topics,
   ↑↓ + Enter (or number keys) saves into that topic's `to_be_ordered`;
   "close tab after adding" is optional.
2. **⌥⇧N** → note window; files the tab first (with a topic picker) if it
   isn't saved yet, then edits the note; ⌘/Ctrl+Enter saves.
   "Close tab after saving" checkbox is unchecked by default.
3. **⇧⌘Space** → popup: quick Add for the current tab, "File all tabs in this
   window" bulk filing (each tab defaults to NoTopic; rules override; "— skip —"
   excludes the tab; "Close tabs after filing" checkbox unchecked by default),
   search, recents.
4. In the manager: drag entries between queues or onto a sidebar topic to move
   cross-topic, use Order → / Done ✓, edit notes inline, add a domain rule
   (e.g. `example.com` → News) and reload a matching page to see the "suggested"
   badge pre-selected in the picker, and try Settings → Export / Import JSON.

### Notes for future test automation

- Chrome 152 blocks `--remote-debugging-port` on the default profile and has
  removed `--load-extension` from branded Stable builds, so CDP-driven testing
  of this extension requires either an older Chrome or a fresh
  `--user-data-dir` plus a manual unpacked install.
- AppleScript UI scripting via System Events is not authorized for shell
  processes in this environment.
- Long-running accessibility sessions can degrade the computer-use helper's
  cached view of Chrome (duplicated menu-bar elements, unreadable windows);
  restarting the helper (quit and reopen ZCode) clears it. Restarting Chrome
  alone does not.

## Known limitations

- **YouTube enrichment needs a user-provided API key** (Settings). Without
  it — or when the key is invalid/quota-exceeded — watch URLs are classified
  by URL rules only and entries carry no channel/publish-date stamp; failures
  surface as console warnings.
- **Channel-id/name rules don't fire on channel pages** —
  `youtube.com/@handle/…` URLs are still matched by handle rules only,
  because resolving a handle to its `UC…` id needs a second API call that
  isn't built.
- **One topic per URL** — saving an already-saved URL moves it (note kept,
  queue reset to `to_be_ordered`).
- **Deleting a topic requires moving its entries** to another topic first;
  rules targeting a deleted topic are removed.
- Keyboard bindings live in Chrome, so they cannot be *applied* from an import
  file; the export includes a reference copy of the manifest shortcuts, but
  changing actual bindings is done at `chrome://extensions/shortcuts`.
- Data is local to this browser profile (`chrome.storage.local`); no sync.
- Concurrent edits from two extension surfaces at once (e.g. popup and manager)
  are last-write-wins on the whole state — fine for a single user, noted for
  future improvement.
