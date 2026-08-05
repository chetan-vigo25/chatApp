/**
 * ShareManager — normalize the raw `shareIntent` from expo-share-intent into the
 * exact shape ChatScreen's `sendMedia({ file, type })` expects, so an OS share
 * flows through the SAME upload pipeline (optimistic bubble → compression →
 * chunked upload → OutboxWorker retry) as an in-app attachment. Nothing here
 * uploads or sends — it only translates.
 *
 * expo-share-intent `shareIntent` shape:
 *   { text, webUrl, files: [{ path, mimeType, fileName, size, width, height, duration }], meta }
 * `path` is already a `file:///…` URI RN can read.
 */

/** Map a MIME type to the media `type` sendMedia understands. */
function typeFromMime(mime = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document'; // sendMedia normalizes 'document' → 'file'
}

/**
 * @param {object} shareIntent  raw object from useShareIntentContext()
 * @returns {{ files: Array, text: (string|undefined) }}
 *   files: [{ file: { uri, name, type, size, width, height }, type }]
 *   text:  shared plain text / URL (composer prefill), if any
 */
export function normalizeShare(shareIntent) {
  if (!shareIntent) return { files: [], text: undefined };

  const rawFiles = Array.isArray(shareIntent.files) ? shareIntent.files : [];

  const files = rawFiles
    .filter((f) => f && (f.path || f.uri))
    .map((f) => {
      const rawPath = f.path || f.uri;
      const uri = String(rawPath).startsWith('file://') ? rawPath : `file://${rawPath}`;
      const mimeType = f.mimeType || 'application/octet-stream';
      const name = f.fileName || uri.split('/').pop() || `shared_${Date.now()}`;
      return {
        type: typeFromMime(mimeType),
        file: {
          uri,
          name,
          type: mimeType,
          size: Number(f.size) || 0,
          width: Number(f.width) || undefined,
          height: Number(f.height) || undefined,
        },
      };
    });

  // Plain text / URL shares (no files) → prefill the composer instead of sending.
  const text = shareIntent.text || shareIntent.webUrl || undefined;

  return { files, text: files.length === 0 ? text : undefined };
}
