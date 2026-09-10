// YouTube Data API v3 client for video metadata enrichment (v2 feature).
// One videos.list call per video id returns publishedAt, channelId, and
// channelTitle — the three fields channel rules and the entry stamp need.
// Results are cached in state.ytMeta via ensureYtMeta() so each video is
// fetched at most once. fetchImpl is injectable so the Node test suite can
// exercise this module without network access. Without an API key, on fetch
// failure, or for non-video URLs, everything degrades to v1 URL-only rules.

import { youtubeVideoIdOf, normalizeYtMeta, pruneYtMeta } from './logic.js';

const API_URL = 'https://www.googleapis.com/youtube/v3/videos';

export async function fetchVideoMeta(videoId, apiKey, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!videoId || !apiKey || !doFetch) return null;

  const url = `${API_URL}?part=snippet&id=${encodeURIComponent(videoId)}`;
  let res;
  try {
    res = await doFetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
      },
    });
  } catch (err) {
    console.warn(`Tab Topics: YouTube metadata request failed for ${videoId}:`, err?.message || err);
    return null;
  }
  if (!res.ok) {
    // 403 = key/quota problem, 400 = bad key. Enrichment is skipped but the
    // failure is not cached — a fixed key works on the next save.
    console.warn(`Tab Topics: YouTube API returned HTTP ${res.status} for ${videoId}; enrichment skipped`);
    return null;
  }
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.items)) {
    console.warn(`Tab Topics: unparseable YouTube API response for ${videoId}; enrichment skipped`);
    return null;
  }
  const item = data.items[0];
  if (!item) {
    // Private/deleted videos come back with an empty items list; tombstone
    // them so we don't refetch on every save attempt.
    return normalizeYtMeta({ videoId, unavailable: true, fetchedAt: Date.now() });
  }
  const sn = item.snippet || {};
  const customUrl = typeof sn.customUrl === 'string' ? sn.customUrl : '';
  return normalizeYtMeta({
    videoId,
    channelId: sn.channelId,
    channelName: sn.channelTitle,
    handle: customUrl.startsWith('@') ? customUrl : '',
    publishedAt: sn.publishedAt,
    fetchedAt: Date.now(),
  });
}

// Resolve metadata for a URL from the cache, fetching (and caching) when the
// key is configured and the URL is a YouTube video URL. Returns the usable
// meta record or null; callers persist state afterwards. The API key defaults
// from state.settings so surfaces can call ensureYtMeta(state, url).
export async function ensureYtMeta(state, url, { apiKey, fetchImpl } = {}) {
  const key = apiKey !== undefined ? apiKey : (state.settings && state.settings.ytApiKey) || '';
  const videoId = youtubeVideoIdOf(url);
  if (!videoId || !key) return null;

  const cached = state.ytMeta ? state.ytMeta[videoId] : null;
  if (cached) return cached.unavailable ? null : cached;

  const meta = await fetchVideoMeta(videoId, key, fetchImpl);
  if (meta) {
    if (!state.ytMeta) state.ytMeta = {};
    state.ytMeta[videoId] = meta;
    pruneYtMeta(state);
  }
  return meta && !meta.unavailable ? meta : null;
}
