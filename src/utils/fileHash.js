// utils/fileHash.js
// SHA-256 of a file's BYTES (not of its base64 string) using crypto-js.
//
// expo-crypto is not installed in this project, but crypto-js is — and its
// progressive SHA256 hasher accepts WordArrays built from base64
// (CryptoJS.enc.Base64.parse decodes to the underlying bytes), so the digest
// matches `sha256sum <file>` / the server's content hash.
//
// Files are read in chunks (base64 slices via FileSystem.readAsStringAsync
// position/length) and the JS thread is yielded between chunks so a 16MB hash
// never freezes the UI. Files above MAX_HASH_BYTES are skipped (returns null)
// — hashing large videos in JS is too slow to be worth the dedupe win.
import * as FileSystem from 'expo-file-system/legacy';
import CryptoJS from 'crypto-js';

export const MAX_HASH_BYTES = 16 * 1024 * 1024; // 16MB

// Chunk must be a multiple of 3 so each base64 slice decodes without padding
// bytes bleeding between chunks (3 bytes → 4 base64 chars, no '=' mid-stream).
const CHUNK_BYTES = 768 * 1024;

const yieldToUiThread = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  } catch (error) {
    console.warn('computeFileSha256 failed:', error?.message || error);
    return null;
  }
};

export default computeFileSha256;
