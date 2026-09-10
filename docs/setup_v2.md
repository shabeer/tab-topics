# Tab Topics v2 — Installation & Setup Guide

Step-by-step setup for cross-device sync between the desktop Chrome extension
and the Android PWA. This guide covers Google Cloud Console configuration,
extension updates, PWA deployment, and device-level installation.

**Prerequisites:** A Google account signed in to Chrome on both your desktop
and your Android phone; a GitHub account (for hosting the PWA).

---

## 1. Google Cloud Console — one-time project setup

All OAuth and API configuration happens in one Cloud Console project.

### 1.1 Create a project (or reuse the existing one)

If you already created a project for the YouTube Data API key (v2
enrichment), reuse it — skip to §1.2.

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Click the project dropdown (top-left) → **New Project**.
3. Name it (e.g., `Tab Topics`) → **Create**.
4. Select the new project.

### 1.2 Enable the APIs

You need two APIs enabled in the project:

1. Go to **APIs & Services → Library**.
2. Search for **Google Drive API** → click → **Enable**.
3. Search for **YouTube Data API v3** → click → **Enable** (skip if already
   enabled from v2 setup).

### 1.3 Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Select **External** user type → **Create**.
3. Fill in:
   - **App name:** `Tab Topics`
   - **User support email:** your email
   - **Developer contact:** your email
4. Click **Add or remove scopes** → add:
   - `https://www.googleapis.com/auth/drive.appdata`
5. Click **Save and continue** through the remaining steps.

#### Publishing mode

By default the app is in **Testing** mode. For personal use, either mode
works because the `drive.appdata` scope is classified as **non-sensitive** by
Google — there is no "unverified app" warning screen in either mode.

| Mode | What it means | When to use |
| --- | --- | --- |
| **Testing** | Up to 100 users (added by email in Cloud Console); refresh tokens expire after 7 days, requiring re-sign-in on each device weekly. | Simplest initial setup — just add your own email as a test user. |
| **Production** | No user limit; standard long-lived refresh tokens; user signs in once per device. | Recommended for long-term use — click "Publish App" on the consent screen page. No Google review is needed for non-sensitive scopes. |

#### Why OAuth and not an API key?

Google API keys identify a *project* (for billing and quota) but do not
identify a *user*. The Drive API needs to know *whose* `appDataFolder` to
access, which requires an OAuth access token. There is no way to use a plain
API key for user-specific Drive data — this is a fundamental Google API
constraint. (The YouTube Data API key is different — it accesses public video
metadata, not user-specific data, so an API key works there.)

### 1.4 Create OAuth client credentials

You need **two** OAuth clients in the same project — one for the extension, one
for the web app. Sharing a project is what makes the Drive `appDataFolder`
accessible to both.

#### Client A — Chrome extension

1. Go to **APIs & Services → Credentials → + Create Credentials → OAuth
   client ID**.
2. Application type: **Chrome extension**.
3. Name: `Tab Topics Extension`.
4. Item ID: enter the extension's ID from `chrome://extensions` (e.g.,
   `bnncfndaieaemoibgmgdmcdoakoflgdp`). If you haven't loaded the updated
   extension yet, you can come back and add the ID later.
5. Click **Create**. Copy the **Client ID** (you'll need it for `manifest.json`).

#### Client B — Web application (for the PWA)

1. **+ Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name: `Tab Topics PWA`.
4. **Authorized JavaScript origins:** add the URL where you'll host the PWA:
   - `https://<your-username>.github.io` (for GitHub Pages)
   - If using a custom domain, add that instead.
5. Leave **Authorized redirect URIs** empty (the GIS token client uses popup
   mode, not redirects).
6. Click **Create**. Copy the **Client ID**.

---

## 2. Desktop extension — update and configure

### 2.1 Update the manifest

Open `extension/manifest.json` and add the `identity` and `alarms`
permissions, plus the `oauth2` block:

```jsonc
{
  "permissions": ["tabs", "storage", "favicon", "identity", "alarms"],
  "host_permissions": ["https://www.googleapis.com/*"],
  "oauth2": {
    "client_id": "<Client ID from step 1.4 — Client A>",
    "scopes": ["https://www.googleapis.com/auth/drive.appdata"]
  }
  // ... rest of manifest unchanged
}
```

### 2.2 Reload the extension

1. Open `chrome://extensions`.
2. Click the reload button (↻) on the Tab Topics card.
3. If the extension ID changed after reloading, go back to Cloud Console and
   update the Chrome extension OAuth client's Item ID (§1.4 Client A).

### 2.3 Sign in and enable sync

1. Open the Tab Topics manager (toolbar icon → Manager ↗).
2. Go to **Settings**.
3. Click **Enable sync** (or "Sign in to sync" — the exact label depends on
   the implementation).
4. Chrome's OAuth popup appears. Sign in with the Google account you want to
   use for sync. Approve the `drive.appdata` scope.
5. The first sync pushes your current local state to Drive.

---

## 3. PWA deployment — hosting the Android web app

### 3.1 Create or prepare the repository

**Option A — Same repo:** Add a `pwa/` directory to this repository and
configure GitHub Pages to serve from it.

**Option B — Separate repo:** Create a new GitHub repository (e.g.,
`tab-topics-pwa`) and push the PWA files there. This keeps the extension and
PWA deployments independent.

### 3.2 PWA file structure

The PWA directory contains:

```
pwa/
  index.html              Manager UI (adapted from extension/page/)
  share-receive.html      Share target receiver page
  manifest.webmanifest    Web app manifest (name, icons, share_target, display)
  sw.js                   Service worker for offline caching
  auth.js                 Google Identity Services integration
  icons/
    icon-192.png          Home screen icon
    icon-512.png          Splash screen icon
    icon-192-maskable.png Adaptive icon (Android)
    icon-512-maskable.png Adaptive icon (Android)
  shared/
    logic.js              ← copied from extension/shared/logic.js
    youtube.js            ← copied from extension/shared/youtube.js
    sync.js               ← shared sync engine (new)
    drive.js              ← Drive API wrapper (new)
    store.js              ← extended with indexedDbAdapter (new)
```

The `shared/` modules are identical between the extension and the PWA. During
development, keep them in sync manually or use a symlink / build script.

### 3.3 Configure the PWA manifest

In `pwa/manifest.webmanifest`, set the Web OAuth client ID and share target:

```json
{
  "name": "Tab Topics",
  "short_name": "Tab Topics",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#4a90d9",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-192-maskable.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "share_target": {
    "action": "/share-receive.html",
    "method": "GET",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url"
    }
  }
}
```

**Important:** The `share_target.action` must be an absolute path within the
manifest's scope. Use `/share-receive.html` (not a relative path).

### 3.4 Configure the GIS client ID

In `pwa/auth.js`, set the Web application OAuth client ID:

```javascript
const CLIENT_ID = '<Client ID from step 1.4 — Client B>';
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
```

### 3.5 Deploy to GitHub Pages

1. Push the `pwa/` directory to your GitHub repository.
2. Go to the repo's **Settings → Pages**.
3. Under **Source**, select the branch and folder:
   - If the PWA is in the repo root: select the branch, folder `/`.
   - If the PWA is in `pwa/`: select the branch, folder `/pwa`.
4. Click **Save**. GitHub deploys the site within a minute.
5. Your PWA is now live at `https://<username>.github.io/<repo>/`.

#### Verify HTTPS

GitHub Pages serves over HTTPS by default. Verify by visiting the URL — the
browser should show a lock icon. The GIS token client and the service worker
both require HTTPS.

### 3.6 Update the OAuth client's authorized origin

Go back to Cloud Console → **APIs & Services → Credentials** → edit the
**Web application** OAuth client. Under **Authorized JavaScript origins**,
confirm the URL matches your GitHub Pages URL exactly:

```
https://<username>.github.io
```

If you used a subfolder (`/repo-name/`), only the origin matters — not the path.

---

## 4. Android phone — install the PWA

### 4.1 Open the PWA in Chrome

On your Android phone, open Chrome and navigate to your PWA URL:

```
https://<username>.github.io/<repo>/
```

### 4.2 Install the PWA

Chrome should show an install banner or prompt. If it doesn't:

1. Tap the three-dot menu (⋮) in Chrome.
2. Tap **"Install app"** or **"Add to Home screen"**.
3. Confirm the installation.

The PWA now appears in your app drawer and on your home screen with the
Tab Topics icon.

**Why "Install" and not just "Add to Home screen"?** A properly installed PWA
registers as a share target in Android's share sheet. A mere bookmark shortcut
does not. If "Install app" doesn't appear, check that:

- The PWA is served over HTTPS.
- `manifest.webmanifest` is linked from the HTML (`<link rel="manifest" …>`).
- The manifest includes `name`, `icons` (192px + 512px), `start_url`, and
  `display: "standalone"`.
- A service worker is registered.

### 4.3 Sign in

1. Open the Tab Topics app from your home screen.
2. Tap **Sign in with Google**.
3. The Google sign-in popup appears. Sign in with the **same Google account**
   you used on the desktop extension.
4. Approve the `drive.appdata` scope.
5. The PWA pulls your synced state from Drive. Your topics, entries, notes,
   rules, and settings — including the YouTube API key — all appear
   immediately.

### 4.4 Verify the Share Target

1. Open any page in Chrome on your phone.
2. Tap **Share**.
3. **"Tab Topics"** should appear in the share sheet. Tap it.
4. The Tab Topics share receiver opens with the page's title and URL.
5. Pick a topic and save.

If Tab Topics doesn't appear in the share sheet:

- Make sure you **installed** the PWA (§4.2), not just bookmarked it.
- Try uninstalling and reinstalling the PWA (manifest changes require a full
  reinstall to update the share target registration).
- Check that the `share_target` action URL in the manifest is an absolute path
  within the manifest scope.

---

## 5. Verifying sync is working

### Quick test

1. **Desktop:** Save a new tab to a topic (⌥⇧U → pick topic → confirm).
2. **Android:** Open the Tab Topics app. Wait a few seconds (or tap "Sync now"
   if available). The entry should appear.
3. **Android:** Edit the entry's note. Save.
4. **Desktop:** Open the manager. The updated note should appear within the
   next sync cycle (up to 2 minutes).

### YouTube enrichment test

1. **Desktop:** Ensure a YouTube Data API key is configured in Settings.
2. **Android:** Open the Tab Topics app and verify the API key appears in
   Settings (synced from desktop).
3. **Android:** Share a YouTube video via the share sheet to Tab Topics.
4. **Android:** The share receiver should show the channel name and
   pre-select a topic if a matching `ytChannelId` or `ytChannelName` rule
   exists.
5. **Desktop:** The entry appears with the `Channel Name · Published Date`
   subtitle.

---

## 6. Troubleshooting

### "This app isn't verified" warning during sign-in

This should **not** appear for Tab Topics because the `drive.appdata` scope is
classified as non-sensitive. If you do see it, check that:

- You have not accidentally added a sensitive or restricted scope (e.g.,
  `drive.readonly`, `drive`, `gmail.readonly`) in the consent screen
  configuration. Only `drive.appdata` should be listed.
- The OAuth consent screen is configured correctly in Cloud Console.

If the warning does appear despite correct configuration, you can still
proceed: click **Advanced** → **Go to Tab Topics (unsafe)** → approve.

### Sync not working — token expired

- **Testing mode:** Refresh tokens expire after 7 days. You'll need to
  re-sign-in on each device weekly. To avoid this, switch to production mode
  (§1.3) — no review is needed for non-sensitive scopes like `drive.appdata`.
- **Production mode:** Refresh tokens are long-lived and should renew
  automatically. If sync stops, sign out and sign back in.
- **PWA (both modes):** GIS token client tokens last ~1 hour. If you haven't
  used the app in over an hour, tap "Sync" or "Sign in" to re-authenticate.
  This is normal behavior for web-based OAuth.

### Share target not appearing on Android

- The PWA must be **installed**, not bookmarked. Uninstall and reinstall via
  Chrome's "Install app" menu option.
- After updating the PWA's `manifest.webmanifest`, you must uninstall and
  reinstall for the share target to update.
- Some Android launchers cache the share sheet; try restarting the phone.

### YouTube metadata not fetching on Android

- Check that the API key is visible in the PWA's Settings (should have synced
  from desktop).
- The YouTube Data API endpoint (`googleapis.com/youtube/v3/videos`) requires
  CORS — this works in Chrome on Android. If you see CORS errors in DevTools,
  ensure the request uses the API key in the header, not as a query parameter
  with a restricted key.
- Quota: the free tier allows 10,000 units/day. Each video fetch costs 1 unit.
  If you're over quota, metadata fetches fail silently and enrichment is
  skipped (existing v2 behavior).

### Extension ID changed after updating manifest

If you added the `oauth2` block and reloaded the extension, the extension ID
may change (this happens with unpacked extensions when the key changes). If so:

1. Note the new ID from `chrome://extensions`.
2. Go to Cloud Console → Credentials → edit the Chrome extension OAuth client.
3. Update the Item ID to the new extension ID.

---

## 7. Uninstalling / disabling sync

### Disable sync on the desktop extension

1. Open the manager → Settings.
2. Click **Disable sync** or **Sign out**.
3. The extension reverts to local-only storage. Existing data remains intact.

### Uninstall the PWA on Android

1. Long-press the Tab Topics icon on your home screen.
2. Tap **Uninstall** (or drag to "Remove").
3. The PWA is removed. Data in the phone's IndexedDB is cleaned up by Chrome.

### Delete synced data from Drive

The sync file is stored in Drive's hidden `appDataFolder`. To delete it:

1. Go to [Google Drive Security Settings](https://myaccount.google.com/permissions).
2. Find **Tab Topics** in the list of third-party apps.
3. Click **Remove Access**. This revokes the OAuth grant *and* deletes the
   `appDataFolder` data.

---

## 8. Reference: complete list of accounts, keys & costs

| Item | Where to find it | Where it goes | Cost |
| --- | --- | --- | --- |
| Chrome extension OAuth Client ID | Cloud Console → Credentials → Client A | `extension/manifest.json` → `oauth2.client_id` | Free |
| Web application OAuth Client ID | Cloud Console → Credentials → Client B | `pwa/auth.js` → `CLIENT_ID` | Free |
| YouTube Data API key | Cloud Console → Credentials → API Key | Extension Settings → "YouTube Data API key" (syncs to PWA automatically) | Free (10,000 units/day) |
| Extension ID | `chrome://extensions` | Cloud Console → Client A → Item ID | — |
| GitHub Pages URL | GitHub repo → Settings → Pages | Cloud Console → Client B → Authorized JavaScript origins | Free (100 GB/mo bandwidth) |

**Note:** No API key is needed for Google Drive. Drive requires OAuth (user
identity) to access the `appDataFolder`. The YouTube Data API key is a
separate credential that accesses public video metadata — it continues to work
unchanged.
