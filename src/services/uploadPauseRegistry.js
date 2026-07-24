// Module-level pause/cancel registry for OUTGOING media uploads.
//
// Keyed by the upload-queue row's tempId (== the socket clientMessageId of the
// optimistic bubble). The registry is intentionally tiny and in-memory only —
// durable paused state lives on the persisted `media_upload_queue_<userId>`
// rows (`paused: true`), which useChatLogic re-hydrates into this registry at
// boot so a killed app comes back still paused.
//
// How a pause actually stops bytes:
//   - direct (XHR multipart) uploads register an AbortController abort fn via
//     registerUploadAbort(); pauseUpload()/cancelUpload() fire it.
//   - chunked uploads poll isUploadPaused() between chunks (see
//     utils/chunkedUpload.js `isPaused` option) and stop cleanly — the server
//     session keeps receivedBytes so resume continues from that offset.
const pausedKeys = new Set();
const cancelledKeys = new Set();
const abortFns = new Map(); // key -> Set<fn>
const listeners = new Set();

export const UPLOAD_PAUSED_MESSAGE = 'upload paused';
export const UPLOAD_CANCELLED_MESSAGE = 'upload cancelled';

const emit = () => {
  const snapshot = Array.from(pausedKeys);
  for (const listener of listeners) {
    try { listener(snapshot); } catch { /* listener errors never break transfers */ }
  }
};

const fireAborts = (key) => {
  const fns = abortFns.get(key);
  if (!fns) return;
  for (const fn of Array.from(fns)) {
    try { fn(); } catch { /* best-effort */ }
  }
};

export const subscribeUploadPause = (listener) => {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getPausedUploadKeys = () => Array.from(pausedKeys);

export const isUploadPaused = (key) => pausedKeys.has(String(key));

export const isUploadCancelled = (key) => cancelledKeys.has(String(key));

// Flag the upload paused and abort any in-flight request for it. The upload
// pipeline sees the flag/abort and returns a paused (not failed) result.
export const pauseUpload = (key) => {
  const k = String(key || '');
  if (!k) return;
  cancelledKeys.delete(k);
  if (!pausedKeys.has(k)) {
    pausedKeys.add(k);
    emit();
  }
  fireAborts(k);
};

// Clear the paused flag (before re-running the upload).
export const resumeUpload = (key) => {
  const k = String(key || '');
  if (!k) return;
  cancelledKeys.delete(k);
  if (pausedKeys.delete(k)) emit();
};

// Flag the upload cancelled and abort in-flight bytes. The pipeline checks
// isUploadCancelled() BEFORE isUploadPaused() so cancel wins the race with an
// abort-triggered catch block.
export const cancelUpload = (key) => {
  const k = String(key || '');
  if (!k) return;
  cancelledKeys.add(k);
  if (pausedKeys.delete(k)) emit();
  fireAborts(k);
};

// Forget every flag for a key (upload finished or its message was removed).
export const clearUploadFlags = (key) => {
  const k = String(key || '');
  if (!k) return;
  cancelledKeys.delete(k);
  if (pausedKeys.delete(k)) emit();
};

export const registerUploadAbort = (key, fn) => {
  const k = String(key || '');
  if (!k || typeof fn !== 'function') return () => {};
  const set = abortFns.get(k) || new Set();
  set.add(fn);
  abortFns.set(k, set);
  return () => {
    const current = abortFns.get(k);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) abortFns.delete(k);
  };
};

// Boot-time hydration from persisted queue rows (paused: true) so a relaunch
// keeps paused uploads paused (and the flush loop keeps skipping them).
export const hydratePausedUploads = (keys = []) => {
  let changed = false;
  for (const key of Array.isArray(keys) ? keys : []) {
    const k = String(key || '');
    if (k && !pausedKeys.has(k)) {
      pausedKeys.add(k);
      changed = true;
    }
  }
  if (changed) emit();
};

export const isUploadPausedError = (err) =>
  new RegExp(UPLOAD_PAUSED_MESSAGE, 'i').test(String(err?.message || err || ''));
