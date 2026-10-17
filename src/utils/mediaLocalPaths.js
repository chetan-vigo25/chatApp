// Pure helpers for the on-device media record (no React Native imports, so node --test can load it).
//
// Why: downloaded media is stored under `documentDirectory/TalksTry/...`, and the record keeps
// that path as an ABSOLUTE `file:///…/Documents/TalksTry/...` string. On iOS the app container
// path (`…/Containers/Data/Application/<UUID>/`) is not guaranteed to survive an update,
// reinstall or restore — the file is still inside the new container, but every stored path
// points at the old one. These helpers re-base such a path onto the CURRENT documentDirectory.

// Folders the app itself creates under documentDirectory (downloads + sent copies).
const APP_MARKERS = ['/TalksTry/Media/', '/TalksTry/Sent/'];

/**
 * Re-base a stored app-media path onto `docDir` (the CURRENT documentDirectory, with a trailing slash).
 * Returns the input unchanged when it already lives under `docDir`, is not an app-media path, or is
 * on shared Android storage (`/Android/media/…` is stable across updates and must not be rewritten).
 */
function rebaseMediaPath(path, docDir) {
  if (typeof path !== 'string' || !path || typeof docDir !== 'string' || !docDir) return path;
  if (path.startsWith(docDir)) return path;
  if (path.includes('/Android/media/')) return path;
  let at = -1;
  for (const marker of APP_MARKERS) {
    const i = path.indexOf(marker);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return path;
  const tail = path.slice(at + 1); // "TalksTry/Media/…"
  return `${docDir.endsWith('/') ? docDir : `${docDir}/`}${tail}`;
}

/** Candidate locations to test, in order: the stored path, then its re-based form. */
function candidateMediaPaths(path, docDir) {
  if (typeof path !== 'string' || !path) return [];
  const rebased = rebaseMediaPath(path, docDir);
  return rebased && rebased !== path ? [path, rebased] : [path];
}

/**
 * True for files the app itself keeps under documentDirectory (downloads / sent copies): the only
 * paths a render-time check may judge. Android shared storage (`/Android/media/…`, checked through
 * MediaStore elsewhere), picker `content://`/`ph://` URIs and remote URLs are not ours to verify.
 */
function isRebasableAppPath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) && !path.startsWith('file://')) return false;
  if (path.includes('/Android/media/')) return false;
  return APP_MARKERS.some((marker) => path.includes(marker));
}

module.exports = { rebaseMediaPath, candidateMediaPaths, isRebasableAppPath, APP_MARKERS };
