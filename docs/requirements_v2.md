# Tab Topics v2 — Cross-Device Sync Requirements

**Status:** Draft — pending review before implementation
**Date:** 2026-09-10
**Depends on:** v1 as-built (§7 of `requirements-review.md`) and v2 YouTube enrichment (§8)

---

## 1. Summary

Add bidirectional sync between desktop Chrome (extension) and Android Chrome
(PWA companion app) so a single user can save tabs, edit notes, move entries
between queues, and manage topics from either device. The synced state includes
YouTube metadata stamps (`entry.yt`), the user's YouTube Data API key, and all
rule types (including `ytChannelId` and `ytChannelName`). YouTube enrichment
runs on both clients using the shared API key so that channel-based rules
suggest topics correctly regardless of which device saves the tab.

---

## 2. Constraints

| Constraint | Detail |
| --- | --- |
| No server to maintain | Sync backend is the user's own Google Drive (`appDataFolder`). No custom API, database, or cloud function. |
| Zero recurring cost | All services used are free: Google Drive API (state file is a few KB against the user's 15 GB quota), GitHub Pages (100 GB/month bandwidth, 1 GB site — soft limits, no paid plan needed), YouTube Data API (10,000 free units/day, unchanged from v2). |
| OAuth required (not API key) | An API key identifies a *project* but not a *user*; Drive needs to know whose `appDataFolder` to access, so OAuth is mandatory. The `drive.appdata` scope is classified as **non-sensitive** by Google — no security review, no "unverified app" warning, and no verification process required. |
| Same Google account | Both clients authenticate as the same Google user. The `drive.appdata` scope grants access to a hidden per-app folder visible only to OAuth clients that share the same Cloud Console project. |
| Minimal permissions | The extension adds only two new permissions: `identity` (for `chrome.identity.getAuthToken`) and `alarms` (for reliable periodic sync in MV3 — `setTimeout` is unreliable because service workers are ephemeral). The existing `host_permissions: ["https://www.googleapis.com/*"]` already covers Drive API calls. |
| Offline-first | Every mutation writes to local storage immediately (extension → `chrome.storage.local`; PWA → IndexedDB). Sync pushes/pulls when online; the app is fully functional without a network connection. |
| No Android app install | The Android experience is a Progressive Web App (PWA) served over HTTPS. The user installs it via Chrome's "Add to Home screen" / "Install app" flow — no Play Store listing required. |
| Static hosting only | The PWA is a set of static files (HTML, JS, CSS, icons). No server-side code, no build step. GitHub Pages, Cloudflare Pages, or any static host with HTTPS works. Hosting is required because PWA service workers and Web Share Target registration require HTTPS — `file://` and `chrome-extension://` URLs cannot serve PWAs. |

---

## 3. Architecture

### 3.1 Clients

**Desktop Chrome Extension (existing, extended)**

- Gains an `oauth2` block in `manifest.json` with the Chrome-app OAuth client
  ID and `scopes: ["https://www.googleapis.com/auth/drive.appdata"]`.
- Gains the `"identity"` permission (for `chrome.identity.getAuthToken`).
- A new `shared/sync.js` module handles the pull-merge-push cycle.
- The service worker triggers sync on: alarm interval, after local mutations
  (debounced), and when the popup/manager opens.

**Android PWA (new)**

- A static web app (`pwa/`) reusing `shared/logic.js`, `shared/youtube.js`,
  and the manager UI from `extension/page/`.
- Served over HTTPS from GitHub Pages (or equivalent).
- Uses Google Identity Services (GIS) token client for OAuth — the
  `accounts.google.com/gsi/client` library runs in Android Chrome and returns
  an access token for Drive API calls.
- Stores state locally in IndexedDB via a new `indexedDbAdapter` implementing
  the same `get()`/`set()` interface as the existing `chromeAdapter` in
  `shared/store.js`.
- Declares a `share_target` in its web app manifest so it appears in Android's
  system share sheet (see §4.5).
- Runs `display: "standalone"` so it opens full-screen like a native app.

### 3.2 Sync backend

Google Drive's hidden Application Data folder (`appDataFolder`). Both clients
read and write a single JSON file (`tabtopics-state.json`). No other Drive
files are created.

- **Scope:** `https://www.googleapis.com/auth/drive.appdata` — classified as
  sensitive by Google; see §7 for verification implications.
- **CORS:** The Drive REST API supports browser-origin requests, so the PWA
  calls `www.googleapis.com` directly with `Authorization: Bearer <token>` —
  no proxy needed.
- **Quota:** The file counts against the user's 15 GB Drive quota; the state
  payload is typically a few KB.

### 3.3 OAuth clients

Two OAuth clients in one Google Cloud Console project:

| Client type | Used by | Auth mechanism |
| --- | --- | --- |
| Chrome app | Desktop extension | `chrome.identity.getAuthToken({ interactive: true })` — Chrome caches and refreshes the token automatically |
| Web application | Android PWA | Google Identity Services token client (`google.accounts.oauth2.initTokenClient`) — returns a ~1h access token; re-prompts on expiry |

Both request only `drive.appdata`. Because they share the same Cloud Console
project, the `appDataFolder` they access is identical.

---

## 4. Data model changes

### 4.1 Sync metadata on records

Every record that participates in sync gains two fields:

```
updatedAt   : number   // server-adjusted timestamp (see §5.3)
deviceId    : string   // stable per-device identifier (generated once, persisted locally)
```

Record types affected: topics, entries, rules, settings. These fields are
transparent to the existing logic layer — `shared/logic.js` functions do not
read them; the sync engine stamps them after each mutation.

### 4.2 Tombstones

Deleting a topic, entry, or rule writes a tombstone record instead of removing
it from the array:

```
{ id, _deleted: true, deletedAt: <timestamp>, deviceId }
```

Tombstones are retained for 30 days (configurable), then pruned. This prevents
a delete on one device from being resurrected by a stale copy on the other.

Existing deletion semantics are unchanged at the application layer: `deleteTopic`
still requires a move target, `deleteEntry` still reindexes the queue. The sync
layer intercepts and converts the removal into a tombstone before persisting.

### 4.3 Batch IDs for queue reorders

When a user action touches multiple entries atomically (drag-and-drop reorder,
bulk filing, cross-topic drag), all affected entries are stamped with the same
`batchId` (a uid) in addition to their `updatedAt`. The merge algorithm treats
entries sharing a `batchId` as an atomic set: either the entire batch wins or
none of it does. This prevents interleaving of two concurrent reorders.

### 4.4 Sync state envelope

In addition to the application state, each device persists locally:

```
syncMeta: {
  deviceId          : string   // generated once per device
  lastSyncedAt      : number   // server-adjusted timestamp of last successful push
  lastRemoteRevision: string   // Drive file's headRevisionId at last pull
  baseSnapshot      : object   // the merged state as of the last successful sync
  pendingOps        : array    // mutations made locally since lastSyncedAt (optional — for event-log approach)
}
```

All of `syncMeta` lives in local storage only; it is never uploaded to Drive.

### 4.5 YouTube metadata in sync

| Field | Synced? | Rationale |
| --- | --- | --- |
| `settings.ytApiKey` | Yes | Entered once on desktop, shared to Android so mobile enrichment works without re-typing. Stored in Drive file as-is (not masked — the file is in the user's own hidden appData folder). |
| `state.ytMeta` (cache) | No | Regenerable; each device maintains its own 500-item cache locally. Keeping it out of the Drive payload reduces file size and avoids stale-cache conflicts. |
| `entry.yt` (stamps) | Yes | Embedded on the entry record. When desktop saves a YouTube video and stamps it, the stamp syncs to Android so channel name and publish date display without re-fetching. |
| Rules (`ytChannelId`, `ytChannelName`, `ytChannel`) | Yes | Rules sync as regular records. A `ytChannelName` rule created on desktop will suggest the same topic when a matching video is shared from Android. |

---

## 5. Sync protocol

### 5.1 Cycle

```
sync():
  1. Pull remote state from Drive (GET tabtopics-state.json + headRevisionId)
  2. If remote is unchanged since lastRemoteRevision → push-only (skip merge)
  3. Three-way merge: merge(baseSnapshot, localState, remoteState)
  4. Push merged state to Drive (update tabtopics-state.json)
  5. On success: baseSnapshot ← merged, lastRemoteRevision ← new revision
```

### 5.2 Merge algorithm

Record-level last-write-wins with deterministic tiebreaking:

1. Build keyed maps of records from `base`, `local`, and `remote` (key = `id`).
2. For each record present in any map:
   - If only in `local` (new locally) → include.
   - If only in `remote` (new remotely) → include.
   - If in both `local` and `remote` and both changed vs. `base`:
     **conflict** — pick the version with the higher `(updatedAt, deviceId)`
     tuple (lexicographic tiebreak on `deviceId`).
   - If only one side changed vs. `base` → take the changed version.
   - If neither changed → take as-is.
3. Tombstoned records: a tombstone wins over a non-deleted version only if
   `deletedAt > updatedAt` of the live version.
4. Batch integrity: if a batch's entries are split (some won locally, some
   remotely), the side with the higher batch timestamp wins for all entries in
   that batch.
5. Queue positions: after merge, reindex all queues per topic to eliminate gaps
   (reuses existing `reindex` logic).

### 5.3 Clock adjustment

Device clocks are not trusted for ordering. On each sync cycle:

1. Read the `modifiedTime` from the Drive API response (server timestamp).
2. Compute `offset = driveServerTime - Date.now()`.
3. Store the offset per device. When stamping records, use
   `Date.now() + offset` as the `updatedAt` value.
4. The `deviceId` tiebreak handles residual sub-second skew.

### 5.4 Failure handling

- **Push conflict (file changed between pull and push):** Re-pull, re-merge,
  re-push. Retry up to 3 times with exponential backoff.
- **Network failure:** Local state is already saved; sync retries on the next
  cycle. No data loss.
- **Auth failure (token expired):** Re-prompt for consent. On the extension,
  `chrome.identity.getAuthToken({ interactive: true })` handles this. On the
  PWA, GIS re-opens the consent popup.

### 5.5 Sync triggers

| Client | Trigger | Debounce |
| --- | --- | --- |
| Extension | Service worker startup | — |
| Extension | `chrome.alarms` periodic | Every 2 minutes (configurable) |
| Extension | After any local mutation (`saveState`) | 3-second debounce |
| Extension | Popup or manager page opened | — |
| PWA | App launch / page visibility change | — |
| PWA | After any local mutation | 3-second debounce |
| PWA | Manual "Sync now" button | — |

---

## 6. Android PWA — functional requirements

### 6.1 Core features (parity with desktop manager)

The PWA provides the full manager experience:

- **Topics:** Create, rename, delete (with move-target), view counts.
- **Three queues per topic:** `to_be_ordered`, `ordered`, `done`. Entries can
  be moved between queues using buttons (Order →, Done ✓, ← Back). Touch
  drag-and-drop is supported but buttons are the primary mobile interaction.
- **Notes:** View and edit the plain-text note on any entry (inline editor).
- **Rules:** View, create, edit, delete, toggle, and reorder all rule types
  including `ytChannelId`, `ytChannelName`, `ytChannel`, `domain`, and
  `urlPattern`.
- **Search:** Cross-field search (note, title, URL, topic name, channel name).
- **Settings:** YouTube API key, close-after-add preference, sync interval.
- **Export / Import:** Same JSON format as the desktop extension.

### 6.2 Share Target — adding tabs from Android Chrome

The PWA declares a Web Share Target in its manifest:

```json
"share_target": {
  "action": "/share-receive",
  "method": "GET",
  "params": {
    "title": "title",
    "text": "text",
    "url": "url"
  }
}
```

When the user taps **Share → Tab Topics** in Android Chrome (or any app):

1. The PWA opens at `/share-receive?title=…&url=…`.
2. If the URL is a YouTube video and the API key is configured, YouTube metadata
   is fetched via `ensureYtMeta()` (reusing `shared/youtube.js`).
3. Rules are evaluated via `matchUrl()` — including `ytChannelId` and
   `ytChannelName` rules using the freshly fetched or cached metadata.
4. A topic picker screen shows the suggested topic pre-selected.
5. The user taps Save. The entry lands in the topic's `to_be_ordered` queue.
6. The save writes to IndexedDB immediately; sync pushes to Drive when online.

**Limitations:** The PWA cannot close the originating Chrome tab after saving —
no web API provides this. The share is fire-and-forget.

### 6.3 Manual URL entry

A text input at the top of the manager allows the user to paste a URL and
title manually. This is useful when the share sheet is not available or the
user wants to add a URL from another source.

### 6.4 Responsive layout

The desktop manager layout (sidebar + three queue columns at 40:40:20) adapts
for mobile:

- **Sidebar:** Collapses into a hamburger menu / drawer or a dropdown topic
  selector at the top.
- **Queue columns:** Stack vertically as collapsible accordion sections, or
  render as three swipeable tabs (To be ordered / Ordered / Done).
- **Touch targets:** Minimum 44×44px tap targets; adequate spacing for thumbs.
- **Entry actions:** "Order →", "Done ✓", edit note (✎), and delete (✕)
  buttons are prominently visible on each card.

### 6.5 Offline behavior

The PWA works fully offline:

- A service worker caches all static assets (HTML, JS, CSS, icons) on install.
- All reads and writes go to IndexedDB.
- When the device comes back online, pending changes sync to Drive.
- A visual indicator shows sync status (synced / syncing / offline / error).

---

## 7. OAuth, permissions & cost analysis

### 7.1 Why OAuth and not an API key

Google API keys identify a *project* (for billing and quota) but do not
identify a *user*. The Drive API needs to know whose `appDataFolder` to read
and write, which requires an OAuth access token carrying the user's identity.
There is no way to use an API key for any Drive operation that accesses
user-specific data — this is a fundamental Google API design constraint, not
a configuration choice.

In practice, OAuth is lightweight for this use case:
- **Desktop extension:** `chrome.identity.getAuthToken({ interactive: true })`
  is two lines of code. Chrome handles token caching and silent refresh
  automatically — the user signs in once and never sees OAuth again.
- **Android PWA:** Google Identity Services (GIS) token client opens a sign-in
  popup. Tokens last ~1 hour; when they expire, the user taps "Sync" to
  re-authenticate. For intermittent use this is seamless.

### 7.2 Scope classification — non-sensitive

The `drive.appdata` scope is classified as **non-sensitive** (also called
"recommended") by Google. This is the most permissive classification and means:

- **No Google security review required** — unlike sensitive or restricted
  scopes, non-sensitive scopes do not trigger a verification process.
- **No "This app isn't verified" warning** — the consent screen simply shows
  what the app is requesting and the user approves.
- **No user-count limits** in production mode.
- **Standard token lifetime** — refresh tokens do not expire after 7 days
  (that limitation only applies to testing mode, regardless of scope
  sensitivity).

### 7.3 Consent screen mode

| Mode | Token lifetime | User limit | Consent UX |
| --- | --- | --- | --- |
| Testing | 7-day refresh tokens | 100 explicit test users (added by email) | Clean consent screen, but weekly re-auth due to token expiry |
| Production | Standard refresh tokens (long-lived) | Unlimited | Clean consent screen; user approves once per device |

**Recommendation:** Either mode works for personal use. **Testing mode** is
simplest to set up (just add your own email), but tokens expire weekly.
**Production mode** avoids the weekly re-auth — click "Publish App" on the
consent screen page; no review is needed for non-sensitive scopes.

### 7.4 Scope justification

Only `drive.appdata` is requested. This scope:

- Cannot read or write any user-visible Drive files.
- Cannot list, search, or modify documents, spreadsheets, or photos.
- Accesses only a hidden per-application folder that the user cannot see in
  the Drive UI.
- Is the narrowest Drive scope that supports file storage.
- Is classified as non-sensitive — the lowest-friction tier for consent and
  verification.

### 7.5 Cost summary

Every service used in this feature is free:

| Service | Free tier | Our usage |
| --- | --- | --- |
| Google Drive API | 15 GB storage per account | ~KB state file |
| Google OAuth | No cost | Consent screen + tokens |
| YouTube Data API v3 | 10,000 units/day | 1 unit per video fetch |
| GitHub Pages | 1 GB site, 100 GB/month bandwidth (soft limits) | ~100 KB static PWA |
| GitHub (hosting repo) | Free for public repos, no paid plan needed | Static files only |

---

## 8. Extension manifest changes

```jsonc
// Additions to extension/manifest.json
{
  "permissions": ["tabs", "storage", "favicon", "identity", "alarms"],
  "oauth2": {
    "client_id": "<Chrome-app OAuth client ID from Cloud Console>",
    "scopes": ["https://www.googleapis.com/auth/drive.appdata"]
  }
}
```

**New permissions explained:**

| Permission | Why needed | Alternatives considered |
| --- | --- | --- |
| `identity` | `chrome.identity.getAuthToken` — automatic token caching + silent refresh. | `launchWebAuthFlow` requires only the `identity` permission (no `oauth2` block) but loses automatic caching/refresh and requires substantially more code. Not simpler. |
| `alarms` | `chrome.alarms` for periodic sync. MV3 service workers are ephemeral — `setTimeout`/`setInterval` are canceled when the worker terminates, making them unreliable for intervals longer than a few seconds. | None — `chrome.alarms` is the only reliable mechanism for periodic background work in MV3. |

**No additional `host_permissions` needed:** the existing
`host_permissions: ["https://www.googleapis.com/*"]` (added in v2 for YouTube
enrichment) already covers all Drive REST API endpoints (`/drive/v3/files`,
`/upload/drive/v3/files`).

**API key is not an option for Drive:** an API key identifies a project but not
a user; Drive needs the user's identity to locate their `appDataFolder`. OAuth
is the only authentication path for user-specific Drive data. (The YouTube Data
API key is unaffected — it continues to work as before since it accesses public
video metadata, not user-specific data.)

---

## 9. New modules

| Module | Location | Purpose |
| --- | --- | --- |
| `shared/sync.js` | Extension + PWA | Pure sync engine: pull, merge, push, tombstone handling, batch integrity, clock adjustment. No browser API dependencies — injectable adapters for Drive I/O and clock. |
| `shared/drive.js` | Extension + PWA | Drive REST API wrapper: `downloadState()`, `uploadState()`, `getFileRevision()`. Accepts an access token; used by both the extension (token from `chrome.identity`) and the PWA (token from GIS). |
| `shared/idb-adapter.js` | PWA only | IndexedDB storage adapter implementing the `get()`/`set()` interface from `shared/store.js`. |
| `pwa/manifest.webmanifest` | PWA | Web app manifest with `share_target`, icons, `display: standalone`, app name. |
| `pwa/sw.js` | PWA | Service worker for offline caching of static assets. |
| `pwa/index.html` | PWA | Manager UI, adapted for responsive mobile layout. |
| `pwa/share-receive.html` | PWA | Share target receiver: topic picker for incoming shared URLs. |
| `pwa/auth.js` | PWA | GIS token client initialization, token lifecycle, sign-in/out. |

---

## 10. Testing strategy

### 10.1 Unit tests (Node, `node:test`)

- **Merge algorithm:** Both-dirty conflict (LWW picks newer), delete-vs-edit
  (tombstone wins when newer), concurrent reorder (batch integrity), new on
  both sides (union), no-change (identity).
- **Clock adjustment:** Simulated offset produces correct `updatedAt` values.
- **Tombstone pruning:** Records older than 30 days are removed.
- **Drive adapter:** Mock HTTP responses for download, upload, revision check,
  and error paths (401, 403, 409, network failure).

### 10.2 Integration tests

- End-to-end sync cycle: save on device A → appears on device B within one
  cycle.
- Concurrent edits: edit same note on both → LWW winner with newer stamp.
- Offline resilience: mutation while offline → syncs after reconnect.

### 10.3 Manual verification

- Share Target on Android: share a YouTube video → topic picker with
  channel-based suggestion → verify entry appears on desktop after sync.
- PWA install flow: "Add to Home screen" → app opens standalone → share target
  registered in system share sheet.
- OAuth consent flow on both clients.

---

## 11. Explicitly deferred (beyond this feature)

- Multi-user / shared-topic collaboration (requires access-control layer).
- Real-time sync (WebSocket push from Drive — Drive has no push API for
  appData; polling is the only option).
- Publish-date-based rules.
- Resolving `youtube.com/@handle` channel URLs to `UC…` ids (unchanged from
  v2 YouTube enrichment deferral).
- Key-validation / "test key" UI for YouTube API key.
- Play Store listing or Trusted Web Activity (TWA) wrapper for the PWA.
