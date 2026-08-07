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

// Extension → MIME, used when the OS provider hands us nothing usable. Android
// content providers routinely return `application/octet-stream` (or null) for
// documents — Chrome's download provider and some file managers always do. The
// backend rejects generic binary with "This file type is blocked for security
// reasons", so sending the honest type is the difference between a document
// uploading and a 400.
const EXT_MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  rtf: 'application/rtf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  apk: 'application/vnd.android.package-archive',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
};

/** MIME from a filename's extension, or '' when unknown. */
function mimeFromName(name = '') {
  const parts = String(name).split('.');
  if (parts.length < 2) return '';
  const ext = parts.pop().toLowerCase().split(/[?#]/)[0];
  return EXT_MIME[ext] || '';
}

/** Best-effort file extension from a MIME type, for naming content:// shares. */
function extFromMime(mime = '') {
  const sub = String(mime).split('/')[1] || '';
  const clean = sub.split(';')[0].replace(/[^a-zA-Z0-9]/g, '');
  if (!clean) return '';
  // Generic fallback types carry no real extension — ".octetstream" is worse
  // than no extension at all, and confuses the destination-folder routing in
  // copyToAppFolder.
  if (clean === 'octetstream') return '';
  if (clean === 'jpeg') return 'jpg';
  if (clean === 'quicktime') return 'mov';
  if (clean === 'svgxml') return 'svg';
  return clean.toLowerCase();
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
      const rawPath = String(f.path || f.uri);
      // Android hands back a `content://…` uri whenever the library can't resolve
      // an absolute path (the common case under scoped storage). Blindly
      // prefixing `file://` produced `file://content://…`, a malformed uri that
      // failed every upload — only bare filesystem paths need the scheme added.
      const isContentUri = rawPath.startsWith('content://');
      const uri = (isContentUri || rawPath.startsWith('file://')) ? rawPath : `file://${rawPath}`;
      // A provider-supplied type is trusted UNLESS it's the generic catch-all —
      // Chrome downloads and several file managers label every document
      // `application/octet-stream`, which the backend blocks outright. Recover the
      // real type from the filename extension in that case.
      const providerMime =
        f.mimeType && f.mimeType !== 'application/octet-stream' ? f.mimeType : '';
      // The last path segment of a content:// uri is a MediaStore row id ("1234"),
      // not a filename — and fileName is null when the provider withheld metadata
      // (Android 13+ partial media access), so synthesize one with a real extension.
      const namedFile = f.fileName || (isContentUri ? '' : uri.split('/').pop() || '');
      const mimeType =
        providerMime || mimeFromName(namedFile) || f.mimeType || 'application/octet-stream';
      const ext = extFromMime(mimeType);
      const fallbackName = `shared_${Date.now()}${ext ? `.${ext}` : ''}`;
      const name = namedFile || fallbackName;
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
