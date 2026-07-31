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

// 12MB (was 48MB). A single multipart POST cannot survive a connection drop —
// a 35MB video on a flaky production uplink restarted from byte 0 on every
// hiccup ("upload me bahut time"), while the chunked session resumes from the
// server's receivedBytes. Anything big enough to take >~10s on a mobile uplink
// belongs on the resumable path; small files keep the cheaper single POST
// (which also runs server-side optimization).
export const CHUNKED_UPLOAD_THRESHOLD = 12 * 1024 * 1024;

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

// Use the server's chunkSize EXACTLY. The old version rounded it down to a
// multiple of 3 "for base64 alignment" — but FileSystem.readAsStringAsync's
// position/length are BYTE offsets (each chunk is independently base64-encoded
// and independently decoded server-side), so alignment was never needed. The
// rounding, however, BROKE S3 mode: S3 multipart requires every non-final part
// to be exactly session.chunkSize bytes, and the server enforces it — a 5MB
// (5242880, not divisible by 3) session made every aligned chunk PUT fail 400
// ("Non-final chunks must be exactly N bytes") in production.
const alignChunkSize = (raw) => {
  const size = Number(raw || 0);
  return size > 0 ? Math.floor(size) : DEFAULT_CHUNK_SIZE;
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
  // Deferred hash (chunked-size files skip the pre-upload hash stall): a
  // promise resolving to the sha256 hex (or null). When it lands mid-upload,
  // `dedupCheck(hash)` asks the server whether it already has these bytes —
  // on a hit the session is aborted and the existing media returned, saving
  // the remaining transfer.
  sourceHashPromise = null,
  dedupCheck = null,
  onProgress = null,
  onSession = null,
  session = null,
  // Pause hook — checked between chunks AND every 250ms DURING a chunk (the
  // in-flight PUT is cancelAsync'd, so pause is instant instead of waiting up
  // to a whole 8MB chunk). Returning true stops the loop cleanly with an
  // 'upload paused' error; the session (sessionId + server receivedBytes)
  // stays alive so a later call resumes from the offset.
  isPaused = null,
  // AbortSignal (cancel button) — cancels the in-flight chunk immediately too.
  signal = null,
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
      sourceHashPromise, dedupCheck,
      onProgress, onSession, session: null, isPaused, signal, _freshRetry: true,
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
    // Propose an adaptive chunk size (server clamps to its 5-64MB S3 window,
    // fixed per session): ~6 chunks per file instead of a flat 5MB. Fewer
    // chunks = fewer per-chunk costs (base64 bridge read + temp-file write +
    // HTTP round trip ≈ 1-2s each on mobile). Capped at 8MB: each chunk rides
    // the bridge as a base64 STRING (~1.37× the bytes) — a 16MB chunk meant a
    // ~22MB JS string alloc + copy, a visible app FREEZE (and memory spike)
    // per chunk. 8MB (~11MB string) keeps the stall under control while still
    // halving the round-trips of the old flat 5MB.
    const proposedChunkSize = Math.min(
      8 * 1024 * 1024,
      Math.max(DEFAULT_CHUNK_SIZE, Math.ceil(totalBytes / 6)),
    );
    const initRes = await apiCall('POST', `${SESSION_BASE}/init`, {
      fileName: name || `file_${Date.now()}`,
      fileSize: totalBytes,
      mimeType: mimeType || 'application/octet-stream',
      chunkSize: proposedChunkSize,
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
  // Two alternating temp files so the NEXT chunk can be read+written while the
  // current one is on the wire (see prepareChunk below).
  const tempChunkPaths = [
    `${FileSystem.cacheDirectory}chunk_upload_${sessionId}_a.bin`,
    `${FileSystem.cacheDirectory}chunk_upload_${sessionId}_b.bin`,
  ];
  let consecutiveFailures = 0;
  let consecutive409Recoveries = 0;

  // Cut a chunk into a temp file. Returned promise is pre-guarded against
  // unhandled rejection (a prefetch may be discarded after an offset re-sync).
  const prepareChunk = (chunkOffset, slot) => {
    const length = Math.min(chunkSize, totalBytes - chunkOffset);
    const path = tempChunkPaths[slot];
    const promise = (async () => {
      const chunkB64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: chunkOffset,
        length,
      });
      await FileSystem.writeAsStringAsync(path, chunkB64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    })();
    promise.catch(() => {});
    return { offset: chunkOffset, length, path, slot, promise };
  };

  const pauseRequested = () => {
    try { return typeof isPaused === 'function' && isPaused() === true; } catch { return false; }
  };

  if (pauseRequested()) {
    // Persist the resume point before stopping so the queue row keeps
    // {sessionId, offset} across an app kill.
    reportSession(sessionId, offset);
    throw new Error('upload paused');
  }

  // Mid-flight dedup: when the deferred hash lands, ask the server once
  // whether it already has these bytes. `dedupHit` is checked between chunks;
  // the pending session is aborted and the existing media returned. (When
  // sourceHash was known up front, init already dedup'd — nothing to do.)
  let dedupHit = null;
  if (!sourceHash && sourceHashPromise && typeof dedupCheck === 'function') {
    Promise.resolve(sourceHashPromise)
      .then((hash) => (hash ? dedupCheck(hash) : null))
      .then((existing) => { if (existing) dedupHit = existing; })
      .catch(() => { /* dedup is best-effort — upload continues */ });
  }

  // Token cached across chunks (AsyncStorage read per chunk is wasted time);
  // re-read only after a 401-triggered refresh.
  let token = await getAuthToken();
  // Prefetch state: the next chunk's temp file being cut while the current
  // chunk PUTs. Only used when its offset still matches (409/failure re-syncs
  // move `offset`, invalidating the prefetch — it's simply discarded).
  let prefetch = null;

  try {
    while (offset < totalBytes) {
      if (pauseRequested()) {
        reportSession(sessionId, offset);
        throw new Error('upload paused');
      }

      if (dedupHit) {
        // Server already has these bytes — stop transferring, drop the
        // half-filled session, report done with the existing media.
        abortChunkSession(sessionId).catch(() => {});
        try { onSession?.({ sessionId: null, uri, offset: 0 }); } catch { /* best-effort */ }
        reportProgress(totalBytes);
        return { statusCode: 200, success: true, data: dedupHit, deduplicated: true };
      }

      let current;
      if (prefetch && prefetch.offset === offset) {
        current = prefetch;
      } else {
        // Stale prefetch (offset re-synced): let its write finish before
        // cutting into the OTHER slot, so two writers never share a path.
        if (prefetch) { try { await prefetch.promise; } catch { /* discarded */ } }
        current = prepareChunk(offset, prefetch && prefetch.slot === 0 ? 1 : 0);
      }
      prefetch = null;
      await current.promise;
      const length = current.length;

      // Pipeline: start cutting the NEXT chunk into the other temp slot while
      // this chunk is on the wire — the base64 read/write cost (~1-2s/chunk)
      // then overlaps network time instead of adding to it.
      const nextOffset = offset + length;
      if (nextOffset < totalBytes) {
        prefetch = prepareChunk(nextOffset, current.slot === 0 ? 1 : 0);
      }

      let result = null;
      let failed = false;
      try {
        // createUploadTask (NOT uploadAsync) for REAL per-byte progress: an
        // 8MB chunk on a slow uplink is 30-60s on the wire, and uploadAsync
        // emits nothing until the chunk lands — the bubble ring sat frozen the
        // whole time ("progressbar not working") and the 90s stall watchdog
        // ran blind. The native callback costs nothing (same upload primitive
        // underneath); we throttle emits to ~150ms to keep re-renders cheap.
        let lastByteEmit = 0;
        const chunkBase = offset;
        const uploadTask = FileSystem.createUploadTask(
          chunkUrl,
          current.path,
          {
            httpMethod: 'PUT',
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              'Content-Type': 'application/octet-stream',
              'x-chunk-offset': String(offset),
            },
          },
          (p) => {
            const sent = Number(p?.totalBytesSent || 0);
            if (!(sent > 0)) return;
            const now = Date.now();
            if (sent < length && now - lastByteEmit < 150) return;
            lastByteEmit = now;
            reportProgress(Math.min(chunkBase + sent, chunkBase + length));
          },
        );
        // INSTANT pause/cancel: the old flow only checked isPaused BETWEEN
        // chunks, so tapping ⏸/✕ waited for the whole in-flight chunk (up to
        // 8MB — 30-60s on a slow uplink) before reacting. Watch the flags
        // every 250ms while the chunk is on the wire and cancelAsync() the
        // task the moment they flip; the server keeps receivedBytes, so a
        // resume re-syncs and re-sends only the interrupted chunk.
        let interrupted = false;
        const cancelNow = () => {
          if (interrupted) return;
          interrupted = true;
          uploadTask.cancelAsync().catch(() => {});
        };
        const onAbort = () => cancelNow();
        if (signal) {
          if (signal.aborted) cancelNow();
          else { try { signal.addEventListener('abort', onAbort); } catch { /* older polyfills */ } }
        }
        const pauseWatch = setInterval(() => {
          if (pauseRequested() || dedupHit || (signal && signal.aborted)) cancelNow();
        }, 250);
        try {
          result = await uploadTask.uploadAsync();
        } catch (e) {
          // A cancelAsync-induced rejection is our own interruption, not a
          // network failure — fall through to the interrupted handling below.
          if (!interrupted) throw e;
          result = null;
        } finally {
          clearInterval(pauseWatch);
          if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* best-effort */ } }
        }
        if (interrupted) {
          // Persist the resume point, then surface the intent — these messages
          // are the pipeline's control-flow markers (treated as paused/
          // cancelled, never as a failed upload).
          reportSession(sessionId, offset);
          if (pauseRequested()) throw new Error('upload paused');
          if (signal && signal.aborted) throw new Error('upload cancelled');
          continue; // dedupHit — the loop top returns the existing media
        }
      } catch (err) {
        if (/upload (paused|cancelled)/i.test(String(err?.message || ''))) throw err;
        failed = true;
      }

      const status = Number(result?.status || 0);

      if (!failed && status === 401) {
        // Expired token mid-upload — refresh once and retry this chunk.
        try { await refreshAccessToken({ force: true }); } catch {}
        token = await getAuthToken();
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
    for (const p of tempChunkPaths) {
      FileSystem.deleteAsync(p, { idempotent: true }).catch(() => {});
    }
  }

  let completeRes;
  try {
    completeRes = await apiCall(
      'POST',
      `${SESSION_BASE}/${sessionId}/complete`,
      {},
      // complete() triggers server-side assembly + full-file hashing (+ video
      // poster extraction) — for a 100MB+ file that legitimately exceeds the
      // 15s axios default, which would fail an upload whose bytes all landed.
      { silent: true, retryOnNetwork: true, timeout: 180000 }
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
