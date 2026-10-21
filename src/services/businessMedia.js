// Business-API media. API messages have NO media record (`mediaId` is null),
// so the normal download path can't fetch them. Files come through
//   1. GET <BACKEND_URL>user/chat/message/:messageId/api-media (recipient only,
//      bearer auth, works regardless of S3 CORS/redirects), and if that fails
//      (an older server without the endpoint)
//   2. the message's own `mediaUrl`.
// See docs/BUSINESS_CHAT_README.md §2.3.
//
// Files land in the CACHE directory and are deleted when their viewer closes;
// leftovers older than an hour are swept whenever a new one is fetched. Nothing
// here is a "download" the user keeps (Save-to-gallery copies out of it).
import * as FileSystem from 'expo-file-system/legacy';
import { BACKEND_URL } from '@env';
import { getAccessToken } from './secureTokenStore';

const CACHE_DIR = `${FileSystem.cacheDirectory}business-docs/`;
const SWEEP_AGE_MS = 60 * 60 * 1000;

export class BusinessMediaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // 'unavailable' | 'not_proxyable' | 'no_server_id' | 'network'
  }
}

// The server id (never a temp_… id) — the endpoint only knows server ids.
export const serverIdOf = (msg) => [msg?.serverMessageId, msg?.messageId, msg?.id]
  .map((v) => (v == null ? '' : String(v)))
  .find((v) => v && !v.startsWith('temp_')) || null;

const extOf = (msg) => {
  const name = String(msg?.mediaMeta?.fileName || msg?.mediaUrl || '').split('?')[0];
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  return m ? `.${m[1].toLowerCase()}` : '';
};

const endpointFor = (id) => {
  const base = String(BACKEND_URL || '').replace(/\/$/, '');
  return `${base}/user/chat/message/${encodeURIComponent(id)}/api-media`;
};

const ensureDir = async () => {
  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  } catch { /* downloadAsync reports the real failure */ }
};

// Remove cached copies older than an hour (a viewer that never closed cleanly).
const sweepOld = async () => {
  try {
    const names = await FileSystem.readDirectoryAsync(CACHE_DIR);
    const now = Date.now();
    await Promise.all(names.map(async (n) => {
      const uri = `${CACHE_DIR}${n}`;
      const info = await FileSystem.getInfoAsync(uri);
      const mtimeMs = (info?.modificationTime || 0) * 1000;
      if (info?.exists && mtimeMs && now - mtimeMs > SWEEP_AGE_MS) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }
    }));
  } catch { /* best effort */ }
};

const download = async (url, target, headers) => {
  const res = await FileSystem.downloadAsync(url, target, { headers });
  return res;
};

/**
 * Fetch a business message's file into the cache. Endpoint first, then the
 * message's own mediaUrl. Resolves the local file:// uri; rejects with a
 * BusinessMediaError.
 */
export const fetchBusinessMedia = async (msg) => {
  await ensureDir();
  sweepOld();
  const id = serverIdOf(msg);
  const stem = (id || `m${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '_');
  const target = `${CACHE_DIR}${stem}${extOf(msg)}`;

  let endpointCode = id ? 'unavailable' : 'no_server_id';
  if (id) {
    let token = null;
    try { token = await getAccessToken(); } catch { /* 401 below */ }
    try {
      const res = await download(endpointFor(id), target, token ? { Authorization: `Bearer ${token}` } : {});
      if (res?.status === 200 || res?.status === 206) return res.uri;
      // A 404 body (written to `target`) is JSON; keep only the error code.
      try {
        const body = JSON.parse(await FileSystem.readAsStringAsync(target));
        if (body?.errorCode === 'not_proxyable') endpointCode = 'not_proxyable';
      } catch { /* not JSON */ }
    } catch {
      endpointCode = 'network';
    }
    await deleteBusinessMedia(target);
  }

  // Fallback: the message's own link (older server, or a business-hosted file).
  const url = msg?.mediaUrl;
  if (url && /^https?:\/\//i.test(url)) {
    try {
      const res = await download(url, target, {});
      if (res?.status >= 200 && res?.status < 300) return res.uri;
    } catch { /* fall through */ }
    await deleteBusinessMedia(target);
  }
  throw new BusinessMediaError(endpointCode);
};

export const isBusinessCacheUri = (uri) => Boolean(uri && String(uri).startsWith(CACHE_DIR));

export const deleteBusinessMedia = async (uri) => {
  if (!isBusinessCacheUri(uri)) return;
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* best effort */ }
};
