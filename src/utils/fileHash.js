// utils/fileHash.js
// SHA-256 of a file's BYTES (not of its base64 string) using crypto-js.
//
// expo-crypto is not installed in this project, but crypto-js is — and its
// progressive SHA256 hasher accepts WordArrays built from base64
// (CryptoJS.enc.Base64.parse decodes to the underlying bytes), so the digest
// matches `sha256sum <file>` / the server's content hash.
//
// Files are read in chunks (base64 slices via FileSystem.readAsStringAsync
// position/length) and the JS thread is yielded between chunks so a large hash
// never freezes the UI. Files above MAX_HASH_BYTES are skipped (returns null).
import * as FileSystem from 'expo-file-system/legacy';
import CryptoJS from 'crypto-js';

// 64MB (was 16MB). The 16MB cap meant a 35MB video skipped the pre-upload
// `user/media/exists` dedup check and uploaded EVERY byte — only for the
// server to answer "DEDUP HIT" after the full transfer (observed live in
// production). Hashing 35MB in JS costs seconds; re-uploading it on a mobile
// uplink costs minutes. The hash also rides mediaMeta.contentHash for
// receiver-side integrity checks.
export const MAX_HASH_BYTES = 64 * 1024 * 1024;

// Chunk must be a multiple of 3 so each base64 slice decodes without padding
// bytes bleeding between chunks (3 bytes → 4 base64 chars, no '=' mid-stream).
// ~1MB (999KB — divisible by 3): crypto-js hashes ~1MB in one SYNCHRONOUS
// burst (~100-300ms of JS thread). 3MB chunks blocked the thread ~0.5-1s per
// chunk — with only a 0ms yield between them the whole app visibly FROZE for
// the duration of a big-file hash. ~1MB bursts + a real one-frame yield keep
// touches/animations alive while a 35-64MB hash runs in the background.
const CHUNK_BYTES = 999 * 1024;

// Yield a FULL frame (16ms), not just the microtask queue — setTimeout(0)
// re-blocked the thread on the very next tick, which is why hashing still
// froze scrolling/taps.
const yieldToUiThread = () => new Promise((resolve) => setTimeout(resolve, 16));

// GLOBAL HASH GATE — serialize crypto-js hashing to ONE file at a time.
//
// crypto-js SHA256 is CPU-bound and runs on the JS thread. An album uploads
// ALBUM_UPLOAD_CONCURRENCY tiles at once, so N large videos would hash
// SIMULTANEOUSLY — each ~1MB burst starves the OTHER hashers' 16ms yields, so
// the "yield between chunks" collapses back into one multi-second freeze
// (observed live: 33s VirtualizedList stalls → ANR → the OS kills the app
// mid-album → the upload queue replays on relaunch → duplicate / stuck-at-0/N
// bubbles). Gating hashing to one file at a time keeps upload NETWORK
// concurrency intact (uploads are network-bound, not CPU-bound) while ensuring
// only ONE hasher touches the JS thread — so the per-chunk yields actually keep
// touches/scroll/animation alive and the app is never killed for an ANR.
let _hashGate = Promise.resolve();
const _runExclusiveHash = async (fn) => {
  const prev = _hashGate;
  let release;
  _hashGate = new Promise((resolve) => { release = resolve; });
  try {
    await prev;
  } catch { /* a prior hasher's rejection must not chain-break the gate */ }
  try {
    return await fn();
  } finally {
    release();
  }
};

/**
 * Compute the SHA-256 (hex) of the file at `uri`.
 * Returns null when the file is missing, unreadable, or larger than maxBytes.
 */
export const computeFileSha256 = async (uri, { maxBytes = MAX_HASH_BYTES } = {}) => {
  try {
    if (!uri) return null;

    const info = await FileSystem.getInfoAsync(uri, { size: true });
    if (!info?.exists) return null;

    const size = Number(info?.size || 0);
    if (!size || size > maxBytes) return null;

    // Serialize the CPU-bound chunk loop through the global gate so concurrent
    // album tiles hash one-at-a-time instead of all fighting for the JS thread.
    return await _runExclusiveHash(async () => {
      const hasher = CryptoJS.algo.SHA256.create();

      for (let position = 0; position < size; position += CHUNK_BYTES) {
        const length = Math.min(CHUNK_BYTES, size - position);
        const chunkB64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
          position,
          length,
        });
        if (!chunkB64) return null;
        hasher.update(CryptoJS.enc.Base64.parse(chunkB64));
        // Keep the JS thread responsive between chunks.
        if (position + CHUNK_BYTES < size) await yieldToUiThread();
      }

      return hasher.finalize().toString(CryptoJS.enc.Hex);
    });
  } catch (error) {
    console.warn('computeFileSha256 failed:', error?.message || error);
    return null;
  }
};

export default computeFileSha256;
