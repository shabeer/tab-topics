# Tab Topics v2 — Cross-Device Sync Walkthrough

How syncing works end to end, from the perspective of a user with Tab Topics
on a desktop Chrome browser and the Tab Topics PWA on an Android phone, both
signed in to the same Google account.

---

## 1. The big picture

Your Tab Topics data (topics, entries, queues, notes, rules, settings) lives
in three places at once:

```
Desktop Chrome                     Android Phone
┌──────────────────────┐    ┌──────────────────────┐
│ chrome.storage.local │    │      IndexedDB        │
│  (instant, offline)  │    │  (instant, offline)   │
└──────────┬───────────┘    └──────────┬────────────┘
           │   push / pull             │  push / pull
           └───────────┬───────────────┘
                       ▼
           ┌───────────────────────┐
           │    Google Drive       │
           │  (appDataFolder /    │
           │  tabtopics-state.json)│
           └───────────────────────┘
```

Both devices read and write to the same hidden file in your Google Drive.
The file is invisible in Drive's normal UI — only Tab Topics can see it.
You never interact with Drive directly; the sync happens automatically in
the background.

You sign in once per device with your Google account. This uses OAuth (not an
API key) because Drive needs to know *whose* folder to access — an API key
can't do that. The scope requested (`drive.appdata`) is classified as
**non-sensitive** by Google, so there is no scary warning screen during
sign-in: you simply see what the app is requesting, tap approve, and you're
done. On the desktop extension, Chrome handles token refresh silently — you
never sign in again. On the PWA, tokens last about an hour; after that, you
tap "Sync" to re-authenticate when you next use it.

Every action (saving a tab, editing a note, moving an entry between queues)
writes to local storage first, so the app works instantly even without a
network connection. Changes sync to Drive within a few seconds when online.

---

## 2. Saving a tab on desktop (and Bulk Filing)

The desktop experience offers both quick single-tab saving and bulk window filing:

### Single tab save
1. Press **⌥⇧U** (macOS) or **Alt+Shift+U** (Windows/Linux).
2. The quick picker opens. If a rule matches the current tab's URL, its topic
   is pre-selected. For YouTube videos, channel-based rules
   (`ytChannelId`, `ytChannelName`) also match using cached metadata.
3. Confirm the topic. The entry lands in `to_be_ordered`.
4. Within seconds, the entry syncs to Drive and becomes visible on your phone.

### Bulk filing open tabs
1. Open the popup (toolbar icon or **⇧⌘Space** / **Ctrl+Shift+Space**).
2. Click **File all tabs in this window…**.
3. Tab Topics inspects all open tabs and evaluates topic rules:
   - For YouTube tabs, video metadata is fetched in the background so
     `ytChannelId` and `ytChannelName` rules pre-select the appropriate topics.
   - The dropdowns update asynchronously as channel metadata arrives.
   - You can check **Skip all tabs** to immediately mark all tabs as `— skip —`,
     or uncheck it to restore suggestions.
   - Optional checkboxes let you reverse queue insertion order (right-to-left)
     or automatically close filed tabs.
4. Click **Apply**. Entries are saved with YouTube metadata stamps attached,
   synced to Drive, and filed into their respective queues.

**Notes, queue moves, and all other desktop actions** work seamlessly. In the
manager, you can sort YouTube videos by published date in any queue (`Sort YT ↓` / `Sort YT ↑` toggle)
and use **↗✕** on any entry card to open the URL in a new tab and delete the entry in one step.
Each change is saved locally first, then synced.

---

## 3. Saving a tab on Android — via the Share Sheet

This is the primary way to add tabs from your phone. Android Chrome doesn't
support extensions, so Tab Topics integrates through the system share sheet
instead.

### Step by step

1. **You're browsing a page in Chrome on your phone.** It can be any page —
   an article, a YouTube video, a GitHub repo, anything.

2. **Tap the Share button** (or three-dot menu → Share).

3. **"Tab Topics" appears in the share sheet** alongside other apps. Tap it.

   > This works because the Tab Topics PWA declared itself as a
   > [Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target).
   > The PWA must be properly installed (via Chrome's "Install app" or
   > "Add to Home screen" flow) for it to appear in the share sheet.

4. **The Tab Topics share receiver opens.** It shows:
   - The page's title and URL (received from the share intent).
   - A topic picker with the suggested topic pre-selected.

5. **If the URL is a YouTube video**, the app:
   - Extracts the video ID from the URL (works for `youtube.com/watch?v=`,
     `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, and `m.youtube.com`
     variants).
   - Fetches metadata from the YouTube Data API using your synced API key
     (channel name, channel ID, handle, publish date).
   - Evaluates all rule types — including `ytChannelId` and `ytChannelName`
     — against the fetched metadata.
   - Pre-selects the matching topic. For example, if you have a rule
     `ytChannelName = "3Blue1Brown" → Math`, that topic is pre-selected
     when you share any 3Blue1Brown video.

6. **Tap Save.** The entry is filed into the chosen topic's `to_be_ordered`
   queue and syncs to Drive.

7. **Back on your desktop**, the entry appears in the manager on the next sync
   cycle (within a few seconds to two minutes, depending on when the
   extension's periodic alarm fires).

### What about non-YouTube pages?

Domain and URL-pattern rules work the same way. If you have a rule
`domain = "arxiv.org" → Papers`, sharing an arXiv link from your phone
pre-selects the "Papers" topic automatically.

### Limitations

- The PWA **cannot close the originating Chrome tab** after saving. There is no
  web API for this. The share is fire-and-forget — you stay on the page in
  Chrome after the save completes.
- The share sheet only appears if the PWA is **installed** (not just bookmarked).
  See `setup_v2.md` for installation instructions.

---

## 4. Managing topics and queues on Android

Tap the Tab Topics icon on your home screen to open the full manager.

### What you can do

Everything the desktop manager does, adapted for a phone screen:

- **View topics** — a dropdown or hamburger drawer replaces the desktop sidebar.
- **Browse queues & sort** — the three queues (`to_be_ordered`, `ordered`, `done`)
  display as stacked sections or swipeable tabs. Tap `Sort YT ↓` / `Sort YT ↑` to sort
  the active queue's YouTube videos by published date (newest or oldest first).
- **Move entries between queues** — tap "Order →" to move an entry from
  `to_be_ordered` to `ordered`; tap "Done ✓" to move it to `done`; tap
  "← Back" to reverse.
- **Open and delete in one tap** — tap "↗ Open & Delete" (or `↗✕` on desktop)
  to open the tab URL in a new browser tab and immediately remove the entry from
  the queue.
- **Edit notes** — tap the ✎ button on any entry to open the note editor.
  The on-screen keyboard appears; type or edit the note and tap Save.
- **Create and manage rules** — the Rules panel lets you add, edit, toggle,
  delete, and reorder rules of all types (domain, URL pattern, ytChannel,
  ytChannelId, ytChannelName).
- **Search** — the search bar filters entries across notes, titles, URLs,
  topic names, and YouTube channel names.
- **Export / Import** — the same JSON format as the desktop extension. You can
  export from the phone and import on the desktop, or vice versa.
- **Add a URL manually** — paste a URL into the manual entry field at the top
  if you don't want to use the share sheet.

### YouTube enrichment on mobile

When you add a YouTube video on your phone (via share or manual URL entry),
the PWA calls the YouTube Data API directly — the same `ensureYtMeta()` code
from `shared/youtube.js` running in the browser with standard `fetch()`. The
API supports CORS, so no proxy or server is involved. The API key was
configured on the desktop and synced to the phone automatically.

The metadata cache (`state.ytMeta`) is maintained per-device and is not synced.
The entry stamp (`entry.yt`) — containing channel name, channel ID, handle,
and publish date — is synced with the entry, so both devices display the
enriched subtitle ("Channel Name · Published Date") regardless of which device
originally saved the video.

---

## 5. How conflicts are handled

When both devices edit the same record before syncing, the sync engine resolves
the conflict automatically:

### Example: same note edited on both devices

1. You edit a note on your phone: "Read the intro section."
2. Before it syncs, you edit the same note on your desktop: "Read chapter 2."
3. Next sync: the engine sees both sides changed vs. the last synced base.
4. **Last-write-wins:** the version with the more recent `updatedAt` timestamp
   takes effect. If you edited the phone first and the desktop second, the
   desktop text wins.

### Example: delete on one device, edit on another

1. You delete an entry on your phone (either via Delete or Open & Delete).
2. Before it syncs, you edit the same entry's note on your desktop.
3. The delete is stored as a tombstone with a `deletedAt` timestamp. If the
   tombstone is newer than the edit, the entry stays deleted. If the edit is
   newer, the entry survives.
4. When synced across devices, topic IDs are normalized by name before merging
   entries and rules, ensuring deletions sync reliably even if topics were
   initialized with different IDs on different devices.

### Example: both devices reorder the same queue

1. You drag entries around on your desktop to reorder `to_be_ordered`.
2. On your phone, you move an entry from `to_be_ordered` to `ordered`.
3. The sync engine treats each drag/move as a batch (all entries touched in
   one user action share a `batchId`). The newer batch wins atomically — no
   half-applied reorders.

### What you won't see

- **Merge dialogs or manual conflict resolution.** Every conflict resolves
  automatically via timestamp comparison. This keeps the mobile experience
  seamless.
- **Data loss from offline edits.** All local changes persist and are pushed on
  the next successful sync cycle. If two cycles fail, changes accumulate and
  are merged on the third.

---

## 6. Sync status indicators & background triggers

Both clients show a small indicator so you know whether your data is current:

| Icon / Label | Meaning |
| --- | --- |
| ✓ Synced | Local state matches Drive. All changes have been pushed and pulled. |
| ↻ Syncing | A sync cycle is in progress. |
| ⚠ Offline | No network connection. Changes are saved locally and will sync when online. |
| ✕ Sync error | The last sync attempt failed (auth expired, Drive quota, network). Tap for details. |

### Background triggers

Sync runs automatically behind the scenes:
- **Periodic sync:** Runs every 2 minutes via `chrome.alarms` on the desktop extension.
- **Debounced mutation sync:** Runs 3 seconds after any local edit or save.
- **Immediate settings sync:** Changing settings (such as the YouTube API key or
  close-after-add preference) triggers a sync immediately.
- **Live UI refresh:** The extension popup listens to storage changes and
  re-renders recents and search results in real time if background sync pulls
  fresh remote changes.

---

## 7. YouTube Data API key — how it syncs

The YouTube Data API key and the Drive OAuth token serve different purposes and
should not be confused:

- **YouTube API key** — identifies the project (for quota), accesses *public*
  video metadata. Entered once in Settings, synced to the phone via Drive.
- **Drive OAuth token** — identifies the *user*, accesses their private
  `appDataFolder`. Obtained automatically via Google sign-in. Cannot be
  replaced by an API key because Drive needs to know whose folder to access.

The API key is entered once in the desktop extension's Settings panel (same
as before). When sync is enabled:

1. The key is included in the state pushed to Drive.
2. When the PWA pulls state from Drive, it reads the key from settings.
3. The PWA uses the key for `ensureYtMeta()` calls on videos shared from the
   phone.

The key is stored in the user's hidden `appDataFolder` — not in a
publicly-accessible file. It is not masked in the Drive file (unlike exports,
where it's partially masked) because the file is accessible only to the user's
own OAuth clients.

If you change the API key on one device, the new key syncs to the other on the
next cycle.

---

## 8. What happens when you're offline

Both clients are offline-first:

| Action | Offline behavior |
| --- | --- |
| Save a tab | Saved to local storage immediately. |
| Edit a note | Saved locally. |
| Move between queues | Applied locally. |
| Create/delete topic | Applied locally. |
| YouTube metadata fetch | Skipped (no network). Entry saved without `yt` stamp; metadata can be fetched later. |
| Sync | Skipped. Retries automatically when online. A backlog of local changes accumulates and is merged on the next successful cycle. |

When the device reconnects, the next sync cycle pushes all accumulated changes
to Drive and pulls any changes made on the other device while offline.

---

## 9. Privacy, data flow & cost

All data flows are between your devices and Google's servers. No third-party
server is involved at any point. Every service used is free:

```
Your phone ──────► googleapis.com/drive  (sync state file)       [free, ~KB against 15 GB quota]
Your phone ──────► googleapis.com/youtube (metadata fetch)       [free, 10,000 units/day]
Your desktop ────► googleapis.com/drive  (sync state file)       [free]
Your desktop ────► googleapis.com/youtube (metadata fetch)       [free]
Your phone ──────► <github-pages-url>    (PWA static files)      [free, no data sent to host]
```

- The GitHub Pages host serves static files only. It never receives, stores, or
  processes your Tab Topics data, your API key, or your Google identity.
- The Drive file is in the `appDataFolder`, which is invisible to any other app
  or user — even you can't see it in the Drive web UI.
- The YouTube Data API key is sent only to `googleapis.com` in the
  `X-Goog-Api-Key` header, same as the desktop extension.
