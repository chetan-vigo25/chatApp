// utils/chunkedUpload.js
// Resumable chunked upload for LARGE files (> CHUNKED_UPLOAD_THRESHOLD).
//
// Server contract (all under the media API base):
//   POST   user/media/upload/session/init          → { sessionId, chunkSize, receivedBytes }
//                                                    or { deduplicated: true, completed: true, media }
//   PUT    user/media/upload/session/:id/chunk      raw binary body + x-chunk-offset header
//   GET    user/media/upload/session/:id            → { receivedBytes } (resume point)
//   POST   user/media/upload/session/:id/complete   → { completed: true, media }
//   DELETE user/media/upload/session/:id            → abort
//
// Chunks are cut client-side by writing a base64 slice of the source file to a
// temp file and PUTting it with FileSystem.uploadAsync(BINARY_CONTENT) — RN's
// fetch/XHR cannot send raw bytes, but the native uploader can. On any network
// hiccup the server's receivedBytes is re-queried and the loop resumes from
// there instead of restarting. `onSession` fires whenever {sessionId, offset}
// changes so callers can persist resume state across app restarts.
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_URL } from '@env';
import { apiCall } from '../Config/Https';
import { refreshAccessToken } from '../services/sessionManager';

export const CHUNKED_UPLOAD_THRESHOLD = 48 * 1024 * 1024; // 48MB

const SESSION_BASE = 'user/media/upload/session';
const MAX_CONSECUTIVE_CHUNK_FAILURES = 3;
// HTTP 409 is RECOVERABLE, not fatal: (a) offset mismatch — a retried/timed-out
// chunk double-landed so the server is AHEAD of us, or (b) the per-session
// Redis chunk lock is still held by a previous timed-out request. Both heal by
// waiting and re-syncing to the server's receivedBytes, so 409s get their own
// (higher) cap instead of burning the generic failure budget.
// Must outlast the server's dead-request cleanup: a chunk request that died
// with the network holds the per-session lock until the server's 30s body-idle
// timeout kills it (Redis TTL backstop 60s). 12 tries with capped backoff ≈
// 70s worst case — the lock is guaranteed free before we give up.
const MAX_CONSECUTIVE_409_RECOVERIES = 12;
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

const buildAbsoluteUrl = (endpoint) => {
  if (!BACKEND_URL) return endpoint;
  return `${BACKEND_URL.replace(/\/$/, '')}/${String(endpoint).replace(/^\//, '')}`;
};

const getAuthToken = async () => {
  try {
    return await AsyncStorage.getItem('accessToken');
  } catch {
    return null;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Base64 encodes 3 bytes as 4 chars — chunk reads must start on a multiple of
// 3 or the decoded slice is garbage. Round the server's chunkSize down.
const alignChunkSize = (raw) => {
  const size = Number(raw || 0) > 0 ? Number(raw) : DEFAULT_CHUNK_SIZE;
  return Math.max(3, size - (size % 3));
};

const getSessionStatus = async (sessionId) => {
  const res = await apiCall('GET', `${SESSION_BASE}/${sessionId}`, {}, { silent: true });
  const data = res?.data || res || {};
  return { receivedBytes: Number(data?.receivedBytes || 0) };
};

export const abortChunkSession = async (sessionId) => {
  if (!sessionId) return;
  try {
    await apiCall('DELETE', `${SESSION_BASE}/${sessionId}`, {}, { silent: true });
  } catch { /* best-effort */ }
};

/**
 * Upload `uri` in chunks. Returns an upload-shaped response:
 *   { statusCode: 200, success: true, data: media, deduplicated? }
 * Throws on unrecoverable failure (session state stays persisted via onSession
 * so a later retry resumes).
 */
export const uploadFileInChunks = async ({
  uri,
  name,
  mimeType,
  fileSize,
  chatId = null,
  sourceHash = null,
  onProgress = null,
  onSession = null,
  session = null,
  // Pause hook — checked between chunks. Returning true stops the loop
  // cleanly with an 'upload paused' error; the session (sessionId + server
  // receivedBytes) stays alive so a later call resumes from the offset.
  isPaused = null,
  // Internal: set on the single automatic restart after the server resets a
  // session (HTTP 410 — e.g. its assembly temp file vanished).
  _freshRetry = false,
}) => {
  if (!uri) throw new Error('chunked upload: missing file uri');

  // One-shot restart with a clean session; dedup-by-hash makes it cheap.
  const restartFresh = () => {
    if (_freshRetry) throw new Error('chunked upload: session kept expiring (410)');
    try { onSession?.({ sessionId: null, uri, offset: 0 }); } catch { /* row patch is best-effort */ }
    return uploadFileInChunks({
      uri, name, mimeType, fileSize, chatId, sourceHash,
      onProgress, onSession, session: null, isPaused, _freshRetry: true,
    });
  };

  const info = await FileSystem.getInfoAsync(uri, { size: true });
  if (!info?.exists) throw new Error('chunked upload: source file missing');
  const totalBytes = Number(fileSize || info?.size || 0);
  if (!totalBytes) throw new Error('chunked upload: unknown file size');

  const reportProgress = (loaded) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ loaded: Math.min(loaded, totalBytes), total: totalBytes }); } catch {}
    }
  };
  const reportSession = (sessionId, offset) => {
    if (typeof onSession === 'function') {
      try { onSession({ sessionId, uri, offset }); } catch {}
    }
  };

  let sessionId = session?.sessionId || null;
  let chunkSize = DEFAULT_CHUNK_SIZE;
  let offset = 0;

  // Resume a persisted session if the server still knows it.
  if (sessionId) {
    try {
      const status = await getSessionStatus(sessionId);
      // Session already finalized (duplicate complete answered idempotently).
      if (status?.completed && status?.media) {
        reportProgress(totalBytes);
        return { statusCode: 200, success: true, data: status.media };
      }
      offset = Number(status?.receivedBytes || 0);
    } catch {
      sessionId = null; // expired/unknown/410-reset session — start fresh
    }
  }

  if (!sessionId) {
    const initRes = await apiCall('POST', `${SESSION_BASE}/init`, {
      fileName: name || `file_${Date.now()}`,
      fileSize: totalBytes,
      mimeType: mimeType || 'application/octet-stream',
      ...(sourceHash ? { sourceHash } : {}),
      ...(chatId ? { chatId } : {}),
    }, { silent: true, retryOnNetwork: true });

    const initData = initRes?.data || initRes || {};
    if (initData?.deduplicated && initData?.completed && initData?.media) {
      reportProgress(totalBytes);
      return { statusCode: 200, success: true, data: initData.media, deduplicated: true };
    }

    sessionId = initData?.sessionId;
    if (!sessionId) throw new Error('chunked upload: init returned no sessionId');
    chunkSize = alignChunkSize(initData?.chunkSize);
    offset = Number(initData?.receivedBytes || 0);
  } else {
    chunkSize = alignChunkSize(session?.chunkSize);
  }

  reportSession(sessionId, offset);
  reportProgress(offset);

  const chunkUrl = buildAbsoluteUrl(`${SESSION_BASE}/${sessionId}/chunk`);
  const tempChunkPath = `${FileSystem.cacheDirectory}chunk_upload_${sessionId}.bin`;
  let consecutiveFailures = 0;
  let consecutive409Recoveries = 0;

  const pauseRequested = () => {
    try { return typeof isPaused === 'function' && isPaused() === true; } catch { return false; }
  };

  if (pauseRequested()) {
    // Persist the resume point before stopping so the queue row keeps
    // {sessionId, offset} across an app kill.
    reportSession(sessionId, offset);
    throw new Error('upload paused');
  }

  try {
    while (offset < totalBytes) {
      if (pauseRequested()) {
        reportSession(sessionId, offset);
        throw new Error('upload paused');
      }

      const length = Math.min(chunkSize, totalBytes - offset);

      const chunkB64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: offset,
        length,
      });
      await FileSystem.writeAsStringAsync(tempChunkPath, chunkB64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const token = await getAuthToken();
      let result = null;
      let failed = false;
      try {
        result = await FileSystem.uploadAsync(chunkUrl, tempChunkPath, {
          httpMethod: 'PUT',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Content-Type': 'application/octet-stream',
            'x-chunk-offset': String(offset),
          },
        });
      } catch (err) {
        failed = true;
      }

      const status = Number(result?.status || 0);

      if (!failed && status === 401) {
        // Expired token mid-upload — refresh once and retry this chunk.
        try { await refreshAccessToken({ force: true }); } catch {}
        failed = true;
      }

      if (!failed && status === 410) {
        // Server reset the session (assembly temp file gone) — the old
        // session is unrecoverable; restart once from scratch.
        return restartFresh();
      }

      if (!failed && status === 409) {
        // Recoverable conflict — offset mismatch (server ahead after a
        // double-landed retry) or a stale per-session chunk lock. Back off,
        // re-read the server's receivedBytes and continue from THERE.
        consecutive409Recoveries += 1;
        if (consecutive409Recoveries > MAX_CONSECUTIVE_409_RECOVERIES) {
          throw new Error(`chunked upload failed at offset ${offset} (HTTP 409 not clearing)`);
        }
        await wait(Math.min(8000, 1500 * consecutive409Recoveries));
        try {
          const statusRes = await getSessionStatus(sessionId);
          const serverBytes = Number(statusRes?.receivedBytes);
          if (Number.isFinite(serverBytes) && serverBytes >= 0) {
            offset = serverBytes;
          }
        } catch { /* keep local offset — the next PUT re-triggers 409 handling */ }
        reportSession(sessionId, offset);
        reportProgress(offset);
        continue;
      }

      if (failed || status < 200 || status >= 300) {
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_CONSECUTIVE_CHUNK_FAILURES) {
          throw new Error(`chunked upload failed at offset ${offset}${status ? ` (HTTP ${status})` : ''}`);
        }
        await wait(800 * consecutiveFailures);
        // Re-sync with the server — it may have received part of the chunk.
        try {
          const statusRes = await getSessionStatus(sessionId);
          offset = Number(statusRes?.receivedBytes || offset);
        } catch { /* keep local offset */ }
        continue;
      }

      consecutiveFailures = 0;
      consecutive409Recoveries = 0;
      let body = {};
      try { body = result?.body ? JSON.parse(result.body) : {}; } catch {}
      const serverReceived = Number(body?.data?.receivedBytes ?? body?.receivedBytes ?? 0);
      offset = serverReceived > 0 ? serverReceived : offset + length;

      reportSession(sessionId, offset);
      reportProgress(offset);
    }
  } finally {
    FileSystem.deleteAsync(tempChunkPath, { idempotent: true }).catch(() => {});
  }

  let completeRes;
  try {
    completeRes = await apiCall(
      'POST',
      `${SESSION_BASE}/${sessionId}/complete`,
      {},
      { silent: true, retryOnNetwork: true }
    );
  } catch (err) {
    const httpStatus = Number(err?.response?.status || err?.statusCode || 0);
    if (httpStatus === 410) return restartFresh();
    throw err;
  }
  const completeData = completeRes?.data || completeRes || {};
  if (!completeData?.media) {
    if (/session expired/i.test(String(completeData?.message || ''))) return restartFresh();
    throw new Error(completeData?.message || 'chunked upload: completion returned no media');
  }

  reportProgress(totalBytes);
  return { statusCode: 200, success: true, data: completeData.media };
};

export default uploadFileInChunks;
