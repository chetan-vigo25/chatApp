// utils/mediaService.js
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Alert, Linking } from 'react-native';
import { apiCall } from '../Config/Https';
import { BACKEND_URL } from '@env';
import { uploadFileInChunks, CHUNKED_UPLOAD_THRESHOLD } from './chunkedUpload';
import { ensurePermission, PERMISSION_IDS } from '../features/permissions/ensurePermission';

// Define all directories - using FileSystem.documentDirectory for compatibility
export const APP_FOLDER = 'TalksTry';
export const SENT_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Sent/`;
export const RECEIVED_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Received/`;
export const THUMBNAIL_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Thumbnails/`;
export const MEDIA_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/media/`;

// Media type subdirectories
export const IMAGE_SENT_DIR = `${SENT_DIR}Images/`;
export const VIDEO_SENT_DIR = `${SENT_DIR}Videos/`;
export const DOCUMENT_SENT_DIR = `${SENT_DIR}Documents/`;

export const IMAGE_RECEIVED_DIR = `${RECEIVED_DIR}Images/`;
export const VIDEO_RECEIVED_DIR = `${RECEIVED_DIR}Videos/`;
export const DOCUMENT_RECEIVED_DIR = `${RECEIVED_DIR}Documents/`;

// Backend-tokenized download URLs (/api/v2/user/media/download/:token) now
// REQUIRE the requester's Bearer — an unauthenticated GET is refused. Presigned
// S3 URLs must NOT carry it (S3 rejects requests with two auth mechanisms).
const authHeadersForUrl = async (url) => {
  const isPresigned = /[?&](X-Amz-Signature|X-Amz-Credential)=/i.test(String(url || ''));
  if (isPresigned) return {};
  let token = null;
  try { token = await AsyncStorage.getItem('accessToken'); } catch { /* best-effort */ }
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Track initialization status
let directoriesInitialized = false;
let initializationPromise = null;

// Normalize URI for consistency
export const normalizeUri = (uri) => {
  if (!uri) return uri;
  if (uri.startsWith('file://')) return uri;
  if (uri.startsWith('/')) return `file://${uri}`;
  if (uri.startsWith('content://')) return uri;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return uri;
};

// Current backend ORIGIN (scheme + host[:port]) from the build-time env —
// e.g. "http://192.168.1.37:5000" locally, "https://backend.talkstry.com" live.
const BACKEND_ORIGIN = (() => {
  try {
    const m = String(BACKEND_URL || '').match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1].replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
})();

const isDevOrLanHost = (host) => {
  const h = String(host || '').toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h.endsWith('.local') ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
};

// Make a REMOTE media URL safe to load in <Image>/<Video> in the CURRENT env.
//
// 1. Relative server paths ("/uploads/…") → absolutized against the current
//    backend origin. The server bakes FILE_BASE_URL into mediaUrl at upload
//    time; if that env was missing, clients receive a bare relative path which
//    normalizeUri would wrongly turn into file:///uploads/… (black preview).
// 2. Our-backend media URLs baked with a DEV/LAN host (messages uploaded while
//    the server env pointed at http://192.168.x.x:5000) are remapped onto the
//    current backend origin — a receiver on the live env can't reach the
//    sender's LAN. Only private/LAN hosts with an /uploads/ path are remapped;
//    public hosts (S3, CDN, link previews) are never touched. When the app IS
//    running against that same LAN env, origin matches and nothing changes.
// 3. iOS App Transport Security blocks cleartext http:// (Android debug allows
//    it via usesCleartextTraffic), so remote media loads on Android but
//    silently fails on iOS. Upgrade http→https for real public hosts (and
//    protocol-relative //host → https://). LAN/dev hosts stay http — they have
//    no TLS and forcing https would break local media.
// Local URIs (file://, content://, ph://, assets-library://, data:) and
// existing correct https URLs are returned unchanged — safe no-op.
export const toSecureMediaUri = (uri) => {
  if (!uri || typeof uri !== 'string') return uri;
  let u = uri.trim();

  // Protocol-relative → https
  if (/^\/\//.test(u)) return `https:${u}`;

  // Relative server media path → current backend origin. Only server media
  // paths — anything else relative is ambiguous and left alone.
  if (BACKEND_ORIGIN && /^\/?(uploads|media)\//i.test(u)) {
    return `${BACKEND_ORIGIN}${u.startsWith('/') ? '' : '/'}${u}`;
  }

  // Absolute URL pointing at OUR backend (/uploads/ static media OR /api/
  // endpoints like media download/:token, blob) on a dev/LAN host that is
  // NOT the current backend → remap onto the current backend origin so media
  // sent against a local env still loads on the live env (and vice versa).
  // /api/ matters for dev-over-USB: the server bakes its LAN host into
  // downloadUrl, but the phone can only reach the backend via the adb-reverse
  // 127.0.0.1 tunnel — without the remap every download API URL is unreachable.
  const absMatch = u.match(/^https?:\/\/([^/:]+)(?::\d+)?(\/(?:uploads|api|media)\/.*)$/i);
  if (absMatch && BACKEND_ORIGIN && isDevOrLanHost(absMatch[1])) {
    const remapped = `${BACKEND_ORIGIN}${absMatch[2]}`;
    if (remapped !== u) return remapped;
  }

  const httpMatch = u.match(/^http:\/\/([^/:]+)/i);
  if (httpMatch) {
    // Dev / LAN servers (localhost, 127.x, 10.x, 172.16–31.x, 192.168.x,
    // *.local) are http-only — forcing them to https makes the request fail
    // and the media never loads. Leave those untouched; only upgrade real
    // public hosts (iOS ATS blocks cleartext http to those).
    if (isDevOrLanHost(httpMatch[1])) return u;
    return u.replace(/^http:\/\//i, 'https://');
  }

  return u;
};

// Initialize all app directories (export this function)
export const initializeAppDirectories = async () => {
  // Return existing promise if already initializing
  if (initializationPromise) {
    return initializationPromise;
  }

  // Return immediately if already initialized
  if (directoriesInitialized) {
    return true;
  }

  initializationPromise = (async () => {
    try {
      console.log('📁 Initializing app directories...');
      
      // Create main app folder
      const appDir = `${FileSystem.documentDirectory}${APP_FOLDER}`;
      const appDirInfo = await FileSystem.getInfoAsync(appDir);
      if (!appDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(appDir, { intermediates: true });
        console.log('📁 Created app directory:', appDir);
      }

      // Create all required subdirectories
      const dirs = [
        SENT_DIR,
        RECEIVED_DIR,
        THUMBNAIL_DIR,
        MEDIA_DIR,
        IMAGE_SENT_DIR,
        VIDEO_SENT_DIR,
        DOCUMENT_SENT_DIR,
        IMAGE_RECEIVED_DIR,
        VIDEO_RECEIVED_DIR,
        DOCUMENT_RECEIVED_DIR,
      ];

      for (const dir of dirs) {
        try {
          const dirInfo = await FileSystem.getInfoAsync(dir);
          if (!dirInfo.exists) {
            await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
            console.log(`📁 Created directory: ${dir}`);
          }
        } catch (err) {
          console.warn(`⚠️ Failed to create directory ${dir}:`, err);
        }
      }

      directoriesInitialized = true;
      console.log('✅ All app directories initialized successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize directories:', error);
      directoriesInitialized = false;
      return false;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
};

// Alias for backward compatibility
export const ensureAppFoldersExist = initializeAppDirectories;

// Media-library gate for saving/reading gallery assets.
//
// Routed through the shared in-context helper so a denial (including one made on
// the startup permission screen) is re-asked the next time a feature needs it,
// exactly like the microphone gate in the call flow. `silent` keeps the alerts
// out of these background save/download paths — the screens that call a save
// action own the user-facing messaging.
let _mediaPermissionGranted = false;
export const requestStoragePermission = async ({ silent = true } = {}) => {
  // Skip the system call entirely if we already know it is granted (session cache).
  if (_mediaPermissionGranted) return true;

  const granted = await ensurePermission(PERMISSION_IDS.PHOTOS, {
    silent,
    purpose: 'Allow photo access to save media to your gallery.',
  });
  if (granted) _mediaPermissionGranted = true;
  return granted;
};

// Ensure a specific directory exists
export const ensureDirExists = async (dir) => {
  try {
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return true;
  } catch (err) {
    console.error('❌ ensureDirExists error:', err);
    return false;
  }
};

// Get appropriate directory based on media type and direction
const getDestinationDir = (type, isOutgoing) => {
  const baseDir = isOutgoing ? SENT_DIR : RECEIVED_DIR;
  
  switch (type?.toLowerCase()) {
    case 'image':
    case 'photo':
      return isOutgoing ? IMAGE_SENT_DIR : IMAGE_RECEIVED_DIR;
    case 'video':
      return isOutgoing ? VIDEO_SENT_DIR : VIDEO_RECEIVED_DIR;
    case 'document':
    case 'file':
      return isOutgoing ? DOCUMENT_SENT_DIR : DOCUMENT_RECEIVED_DIR;
    default:
      return baseDir;
  }
};

// Generate safe filename
const generateFilename = (originalUri, prefix = 'file', customExt = null) => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  
  if (customExt) {
    return `${prefix}_${timestamp}_${random}.${customExt.replace('.', '')}`;
  }
  
  // Extract extension from URI
  const uriParts = originalUri.split('.');
  const ext = uriParts.length > 1 ? uriParts.pop().split('?')[0].split('#')[0] : 'bin';
  return `${prefix}_${timestamp}_${random}.${ext}`;
};

// Destinations already claimed by an IN-FLIGHT copy in this session. An album
// copies its files CONCURRENTLY, so an "does this path exist?" check alone
// races: two workers both see "free" and copy to the same path.
const claimedCopyDestinations = new Set();

// Pick a destination that no existing file and no concurrent copy owns.
//
// Album bug (Sep-2026): the destination was `${destDir}${suggestedName}` with
// no uniqueness at all. Two picked photos that share a filename (the picker
// hands out generic names like `image.jpg`, and the compressor's fallback name
// is timestamp-based — identical for files prepared in the same millisecond)
// landed on ONE path, so the second copy overwrote the first and BOTH album
// items uploaded the same bytes → one photo shown for every tile. The original
// name is still used whenever it is free, so shares/saves keep it.
const reserveCopyDestination = async (destDir, filename) => {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0
      ? `${destDir}${filename}`
      : `${destDir}${base}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${attempt}${ext}`;
    if (claimedCopyDestinations.has(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop
    const info = await FileSystem.getInfoAsync(candidate).catch(() => null);
    if (info?.exists) continue;
    claimedCopyDestinations.add(candidate);
    return candidate;
  }
  const fallback = `${destDir}${base}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  claimedCopyDestinations.add(fallback);
  return fallback;
};

// Copy file to app folder
export const copyToAppFolder = async (inputUri, suggestedName = null, destDir = SENT_DIR, onProgress = null) => {
  let claimedDestination = null;
  try {
    if (!inputUri) return null;

    // Ensure directories exist first
    await initializeAppDirectories();

    // Backward compatibility: some call sites pass onProgress in 4th arg
    if (typeof destDir === 'function' && onProgress == null) {
      onProgress = destDir;
      destDir = SENT_DIR;
    }

    const normalizedUri = normalizeUri(inputUri);
    
    // Determine destination directory based on file type if not specified
    if (destDir === SENT_DIR && suggestedName) {
      // Try to determine type from suggestedName or extension
      const ext = suggestedName.split('.').pop()?.toLowerCase();
      if (ext) {
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
          destDir = IMAGE_SENT_DIR;
        } else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
          destDir = VIDEO_SENT_DIR;
        } else if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) {
          destDir = DOCUMENT_SENT_DIR;
        }
      }
    }

    await ensureDirExists(destDir);

    // Generate filename
    const uriWithoutQuery = normalizedUri.split('?')[0];
    const extMatch = uriWithoutQuery.match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1] : '';
    
    const filename = suggestedName
      ? suggestedName.endsWith(ext) ? suggestedName : `${suggestedName}.${ext}`
      : generateFilename(normalizedUri, 'sent');

    const destination = await reserveCopyDestination(destDir, filename);
    claimedDestination = destination;

    console.log('📋 Copying file:', {
      from: normalizedUri.substring(0, 50) + '...',
      to: destination,
      type: destDir.includes('Images') ? 'image' : destDir.includes('Videos') ? 'video' : 'document'
    });

    // Handle remote URLs
    if (/^https?:\/\//i.test(normalizedUri)) {
      const remoteUri = toSecureMediaUri(normalizedUri);
      const downloadResumable = FileSystem.createDownloadResumable(
        remoteUri,
        destination,
        { headers: await authHeadersForUrl(remoteUri) },
        (downloadProgress) => {
          if (onProgress && downloadProgress.totalBytesExpectedToWrite > 0) {
            onProgress(downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite);
          }
        }
      );

      const result = await downloadResumable.downloadAsync();
      return normalizeUri(result.uri);
    }

    // Handle local files
    if (/^file:\/\//i.test(normalizedUri) || normalizedUri.startsWith('/')) {
      await FileSystem.copyAsync({ from: normalizedUri, to: destination });
      return normalizeUri(destination);
    }

    // Handle content URIs (the shape an Android OS share hands us).
    if (/^content:\/\//i.test(normalizedUri)) {
      // copyAsync reads content:// through the ContentResolver, so it works for
      // ANY provider — Drive/Files documents and PDFs included. MediaLibrary is
      // only a fallback: createAssetAsync needs media permission and refuses
      // non-media types, which made every non-gallery share fail here.
      try {
        await FileSystem.copyAsync({ from: normalizedUri, to: destination });
        return normalizeUri(destination);
      } catch (copyErr) {
        console.warn('Content URI copyAsync failed, trying MediaLibrary:', copyErr?.message || copyErr);
      }
      try {
        const asset = await MediaLibrary.createAssetAsync(normalizedUri);
        if (asset && asset.uri) {
          await FileSystem.copyAsync({ from: asset.uri, to: destination });
          return normalizeUri(destination);
        }
      } catch (err) {
        console.warn('Content URI copy failed, using original:', err);
        return normalizedUri;
      }
    }

    return normalizedUri;
  } catch (err) {
    console.warn('copyToAppFolder error:', err);
    return inputUri; // Return original as fallback
  } finally {
    // The written file itself now guards the path (the existence check above
    // sees it) — the in-flight claim only had to survive the copy.
    if (claimedDestination) claimedCopyDestinations.delete(claimedDestination);
  }
};

// Download remote file to received folder
export const downloadRemoteToReceived = async (remoteUrl, filename, onProgress = null, saveToLibrary = true) => {
  try {
    if (!remoteUrl) return null;

    // Ensure directories exist
    await initializeAppDirectories();

    // Determine file type from URL or filename. Only accept a REAL trailing
    // extension — split('.').pop() on a dot-less string returns the whole
    // segment, which then breaks MediaLibrary saves downstream.
    const extOf = (s) => {
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(String(s || '').split('?')[0]);
      return m ? m[1].toLowerCase() : null;
    };
    const ext = extOf(remoteUrl) || extOf(filename) || 'bin';
    
    let destDir = RECEIVED_DIR;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      destDir = IMAGE_RECEIVED_DIR;
    } else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
      destDir = VIDEO_RECEIVED_DIR;
    } else if (['pdf', 'doc', 'docx', 'txt', 'zip'].includes(ext)) {
      destDir = DOCUMENT_RECEIVED_DIR;
    }

    await ensureDirExists(destDir);

    const safeFilename = filename.endsWith(ext) ? filename : `${filename}.${ext}`;
    const destination = `${destDir}${safeFilename}`;

    console.log('📥 Downloading to:', destination);

    // Check if already exists
    const fileInfo = await FileSystem.getInfoAsync(destination);
    if (fileInfo.exists) {
      console.log('✅ File already exists:', destination);
      return normalizeUri(destination);
    }

    const resolvedRemoteUrl = toSecureMediaUri(remoteUrl);
    const downloadResumable = FileSystem.createDownloadResumable(
      resolvedRemoteUrl,
      destination,
      { headers: await authHeadersForUrl(resolvedRemoteUrl) },
      (downloadProgress) => {
        if (onProgress && downloadProgress.totalBytesExpectedToWrite > 0) {
          onProgress(downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite);
        }
      }
    );

    const result = await downloadResumable.downloadAsync();

    // Non-2xx responses still write their body to disk (an error page saved as
    // media renders as a black preview) — delete and fail instead.
    const httpStatus = Number(result?.status || 0);
    if (httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
      try { await FileSystem.deleteAsync(result.uri || destination, { idempotent: true }); } catch { /* best-effort */ }
      throw new Error(`Download failed (HTTP ${httpStatus})`);
    }

    const finalUri = normalizeUri(result.uri);

    if (saveToLibrary) {
      try {
        await saveFileToMediaLibrary(finalUri, APP_FOLDER);
      } catch (err) {
        console.warn('Save to library failed:', err);
      }
    }

    return finalUri;
  } catch (err) {
    console.warn('downloadRemoteToReceived failed:', err);
    return null;
  }
};

/**
 * Save a downloaded file into the app's gallery album — WITHOUT the Android
 * "Allow <app> to modify this photo?" system dialog.
 *
 * Where that dialog came from: the old flow created the asset first (landing it
 * in DCIM/Pictures) and then MOVED it into the album with
 * `addAssetsToAlbumAsync(..., copy=false)` / `createAlbumAsync(..., copy=false)`.
 * On Android 11+ expo-media-library asks for a MediaStore write-request for any
 * move, so every single media download popped a consent dialog.
 *
 * The fix is to never move an existing asset:
 *   • album exists    → `createAssetAsync(uri, album)` writes the file STRAIGHT
 *                       into the album (no existing asset is modified).
 *   • album missing   → `createAlbumAsync(name, null, false, uri)` creates it
 *                       from the FILE URI, so there is no asset id to ask about.
 * Both paths skip `requestMediaLibraryActionPermission` in the native module —
 * and, unlike passing `copy = true`, they leave no duplicate behind.
 */
export const saveAssetToAlbum = async (localUri, albumName = APP_FOLDER) => {
  const normalized = normalizeUri(localUri);
  if (!normalized) return null;

  let album = null;
  try { album = await MediaLibrary.getAlbumAsync(albumName); } catch (_) { album = null; }

  if (album) {
    return await MediaLibrary.createAssetAsync(normalized, album);
  }

  try {
    // `asset` is deliberately null: passing one would make the native module
    // treat this as a MOVE of that asset and raise the write-request dialog.
    await MediaLibrary.createAlbumAsync(albumName, null, false, normalized);
    const created = await MediaLibrary.getAlbumAsync(albumName).catch(() => null);
    if (created) {
      const page = await MediaLibrary.getAssetsAsync({
        album: created, first: 1, sortBy: [MediaLibrary.SortBy.creationTime],
      }).catch(() => null);
      if (page?.assets?.length) return page.assets[0];
    }
    // Album made, asset lookup failed — the file IS saved; the caller only
    // needs a truthy result.
    return { uri: normalized };
  } catch (albumErr) {
    // Older devices / odd OEM MediaStore behaviour: fall back to a plain save
    // (lands in DCIM instead of the album) rather than losing the file.
    console.warn('Album save failed, saving without album:', albumErr?.message || albumErr);
    return await MediaLibrary.createAssetAsync(normalized);
  }
};

// Save file to media library
export const saveFileToMediaLibrary = async (localUri, albumName = APP_FOLDER) => {
  try {
    if (!localUri) return null;
    
    const hasPermission = await requestStoragePermission();
    if (!hasPermission) {
      console.log('⚠️ No media library permission');
      return null;
    }

    return await saveAssetToAlbum(localUri, albumName);
  } catch (err) {
    console.warn('saveFileToMediaLibrary failed:', err);
    return null;
  }
};

// Ask the server whether it already stores these exact bytes (sha256 hex).
// Returns the same-shaped media data an upload would, or null.
export async function mediaExistsByHash({ hash, fileName = null, chatId = null }) {
  if (!hash) return null;
  try {
    // Own short timeout: dedup is an optimization — a dead/slow link must not
    // stall the send for the axios default 15s before the real upload starts.
    const response = await apiCall('POST', 'user/media/exists', { hash, fileName, chatId }, { silent: true, timeout: 5000 });
    const data = response?.data || {};
    if (data?.exists) return data;
    return null;
  } catch {
    return null; // dedupe is best-effort — fall back to a normal upload
  }
}

// Re-resolve fresh media URLs for stale signed URLs (401/403/410 on download).
// ids: array of mediaId or messageId strings. Returns the response data map.
export async function mediaResolve(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return null;
  try {
    const response = await apiCall('POST', 'user/media/resolve', { ids: list }, { silent: true });
    return response?.data || null;
  } catch {
    return null;
  }
}

// Upload media file.
// Extra options (all optional, legacy callers unaffected):
//   onUploadProgress({ loaded, total }) — REAL byte progress (XHR / chunk offsets)
//   sourceHash                          — sha256 of the file bytes; when the server
//                                         already has them the upload is skipped
//   chunkSession / onChunkSession       — resume state for large-file chunked
//                                         uploads (persisted by the caller)
//   signal                              — AbortSignal; aborting it stops the
//                                         direct XHR upload (pause/cancel)
//   isPaused                            — () => bool, polled between chunks by
//                                         the chunked-session path
export const uploadMediaFile = async ({
  file,
  chatId,
  dispatch,
  mediaUploadAction,
  onUploadProgress = null,
  sourceHash = null,
  // Deferred hash for chunked-size files: resolves (to hex or null) while the
  // upload is already running; the chunk loop dedup-checks when it lands.
  sourceHashPromise = null,
  chunkSession = null,
  onChunkSession = null,
  timeoutMs = null,
  signal = null,
  isPaused = null,
}) => {
  let persistentUri = null;
  try {
    if (!file || !dispatch || !mediaUploadAction) {
      throw new Error('Missing params for uploadMediaFile');
    }

    const fileSize = Number(file.size || 0);
    const goesChunked = fileSize > CHUNKED_UPLOAD_THRESHOLD;

    // The Sent/ copy (local disk) and the dedup lookup (one network RTT) are
    // independent — run them in parallel instead of back-to-back. Chunked
    // files skip the /exists RTT entirely: session init already dedups on
    // sourceHash and answers with the finished media.
    const copyPromise = copyToAppFolder(file.uri, file.name, SENT_DIR);
    const existsPromise = (sourceHash && !goesChunked)
      ? mediaExistsByHash({ hash: sourceHash, fileName: file.name || null, chatId })
      : Promise.resolve(null);
    const [copiedUri, existing] = await Promise.all([copyPromise, existsPromise]);

    persistentUri = copiedUri;
    if (!persistentUri || typeof persistentUri !== 'string') {
      throw new Error('Invalid local file URI for upload');
    }

    if (!persistentUri.startsWith('file://') && !persistentUri.startsWith('content://')) {
      throw new Error(`Unsupported upload URI format: ${persistentUri}`);
    }

    // Dedupe: skip the upload entirely when the server already has these bytes.
    if (existing) {
      if (typeof onUploadProgress === 'function' && file.size) {
        try { onUploadProgress({ loaded: file.size, total: file.size }); } catch {}
      }
      return {
        payload: { statusCode: 200, success: true, data: existing },
        localUri: persistentUri,
        deduplicated: true,
      };
    }

    // Large files go through the resumable chunked-session endpoints instead
    // of a single multipart POST (which can't survive a connection drop).
    if (goesChunked) {
      const response = await uploadFileInChunks({
        uri: persistentUri,
        name: file.name || `file_${Date.now()}`,
        mimeType: file.type || 'application/octet-stream',
        fileSize,
        chatId,
        sourceHash,
        sourceHashPromise,
        dedupCheck: (hash) => mediaExistsByHash({ hash, fileName: file.name || null, chatId }),
        onProgress: onUploadProgress,
        onSession: onChunkSession,
        session: chunkSession,
        isPaused,
        signal,
      });
      return { payload: response, localUri: persistentUri };
    }

    const formData = new FormData();
    formData.append('file', {
      uri: persistentUri,
      name: file.name || `file_${Date.now()}.jpg`,
      type: file.type || 'image/jpeg',
    });

    if (chatId) formData.append('chatId', chatId);

    const action = await dispatch(
      (typeof onUploadProgress === 'function' || timeoutMs || signal)
        ? mediaUploadAction({
            formData,
            ...(typeof onUploadProgress === 'function' ? { onUploadProgress } : {}),
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
            ...(signal ? { signal } : {}),
          })
        : mediaUploadAction(formData)
    );

    // Admin-configured per-category limits can sit BELOW the chunked
    // threshold (e.g. video capped at 10MB) — the plain multipart route then
    // 400s with "File size exceeds NMB limit". Large video/documents are what
    // the resumable session path exists for, so retry there instead of
    // failing the send (the session endpoints allow video/document up to the
    // chunked cap by design).
    const plainPayload = action?.payload;
    const plainMsg = String(plainPayload?.message || plainPayload?.error || '');
    const sizeRejected = (plainPayload?.statusCode === 400 || plainPayload?.status === 400)
      && /size exceeds .*limit/i.test(plainMsg);
    const mime = String(file.type || '');
    const chunkableCategory = mime.startsWith('video') || (!mime.startsWith('image') && !mime.startsWith('audio'));
    if (sizeRejected && chunkableCategory && fileSize > 0) {
      const response = await uploadFileInChunks({
        uri: persistentUri,
        name: file.name || `file_${Date.now()}`,
        mimeType: file.type || 'application/octet-stream',
        fileSize,
        chatId,
        sourceHash,
        onProgress: onUploadProgress,
        onSession: onChunkSession,
        session: chunkSession,
        isPaused,
        signal,
      });
      return { payload: response, localUri: persistentUri };
    }

    // Return both server response and local URI
    return {
      ...action,
      localUri: persistentUri
    };
  } catch (err) {
    const message = String(err?.message || err || 'upload failed');
    // Intentional stops (user hit pause/cancel) are control flow, not
    // failures — rethrow silently so callers keep their paused handling and
    // the console doesn't scream ERROR at a working pause button.
    if (/upload (paused|cancelled)/i.test(message)) {
      throw err;
    }
    // Same size-limit fallback when the thunk REJECTED instead of returning
    // a payload (transport-level 400 handling differs across axios versions).
    if (/size exceeds .*limit/i.test(message)) {
      const mime = String(file?.type || '');
      const chunkable = mime.startsWith('video') || (!mime.startsWith('image') && !mime.startsWith('audio'));
      const size = Number(file?.size || 0);
      if (chunkable && size > 0) {
        try {
          // Reuse the copy already made above — a second copyToAppFolder pays
          // another full-file disk write and leaves a duplicate in Sent/.
          if (!persistentUri) {
            persistentUri = await copyToAppFolder(file.uri, file.name, SENT_DIR);
          }
          const response = await uploadFileInChunks({
            uri: persistentUri,
            name: file.name || `file_${Date.now()}`,
            mimeType: file.type || 'application/octet-stream',
            fileSize: size,
            chatId,
            sourceHash,
            onProgress: onUploadProgress,
            onSession: onChunkSession,
            session: chunkSession,
            isPaused,
            signal,
          });
          return { payload: response, localUri: persistentUri };
        } catch {
          // fall through to the normal error path below
        }
      }
    }
    console.error('❌ uploadMediaFile failed:', {
      message,
      fileUri: file?.uri,
      fileType: file?.type,
      fileName: file?.name,
      chatId,
      hints: [
        'Check BACKEND_URL host reachability (avoid localhost on physical device).',
        'Verify internet permission and active connection.',
        'Confirm multipart file URI uses file:// or content:// format.',
        'Confirm server SSL certificate and endpoint availability.',
      ],
    });
    throw err;
  }
};

// Download and open media
export const downloadAndOpenMedia = async ({ msg, dispatch, downloadAction, onProgress = null, openAfterDownload = false, saveToLibrary = true }) => {
  try {
    if (!msg) throw new Error('Invalid message');

    // Check if already downloaded
    if (msg.localUri) {
      const fileInfo = await FileSystem.getInfoAsync(msg.localUri);
      if (fileInfo.exists) {
        if (openAfterDownload) {
          await Linking.openURL(msg.localUri);
        }
        return msg.localUri;
      }
    }

    // Get download URL
    let remoteUrl = msg.mediaUrl || msg.previewUrl || msg.url || null;
    
    if (!remoteUrl && downloadAction && dispatch) {
      const mediaId = msg.serverMessageId || msg.id;
      if (!mediaId) throw new Error('No media id');
      
      const action = await dispatch(downloadAction({ mediaId }));
      remoteUrl = action?.payload?.data?.downloadUrl || 
                  action?.payload?.downloadUrl || 
                  action?.payload?.url || 
                  null;
    }

    if (!remoteUrl) throw new Error('No remote URL to download');

    // Generate filename from message ID
    const filename = `${msg.serverMessageId || msg.id || Date.now()}`;
    
    // Download file
    const localUri = await downloadRemoteToReceived(remoteUrl, filename, onProgress, saveToLibrary);
    
    if (!localUri) throw new Error('Download failed');

    if (openAfterDownload) {
      await Linking.openURL(localUri);
    }

    return localUri;
  } catch (err) {
    console.error('downloadAndOpenMedia error:', err);
    Alert.alert('Download failed', err?.message || 'Unable to download media');
    return null;
  }
};

// Media API functions
export async function mediaAllFiles({ category = null, chatId = null, page = 1, limit = 20, groupByCategory = false } = {}) {
  return apiCall('POST', 'user/media/all/files', {
    category,
    chatId,
    page,
    limit,
    groupByCategory,
  });
}

export async function mediaView(id) {
  return apiCall('POST', 'user/media/view', { id });
}

export async function mediaDelete(id) {
  return apiCall('POST', 'user/media/delete', { id });
}

export async function mediaDownloadSigned(mediaId) {
  return apiCall('POST', 'user/media/download', { mediaId });
}

export async function persistDownloadedMedia({ mediaId, chatId, sourceUrl, fileName, messageType = 'file', onProgress = null }) {
  if (!mediaId) throw new Error('mediaId required');
  if (!sourceUrl) throw new Error('sourceUrl required');

  await initializeAppDirectories();

  const type = String(messageType || 'file').toLowerCase();
  let baseDir = MEDIA_DIR;
  
  if (type === 'image' || type === 'photo') {
    baseDir = IMAGE_RECEIVED_DIR;
  } else if (type === 'video') {
    baseDir = VIDEO_RECEIVED_DIR;
  } else {
    baseDir = DOCUMENT_RECEIVED_DIR;
  }

  await ensureDirExists(baseDir);

  const ext = sourceUrl.split('.').pop()?.split('?')[0] || 'bin';
  const safeFileName = fileName || `${mediaId}.${ext}`;
  const destination = `${baseDir}${safeFileName}`;

  // Check if already exists
  const fileInfo = await FileSystem.getInfoAsync(destination);
  if (fileInfo.exists) {
    console.log('✅ File already exists:', destination);
    return normalizeUri(destination);
  }

  console.log('[MEDIA:DOWNLOAD:START]', mediaId);
  
  const resolvedSourceUrl = toSecureMediaUri(sourceUrl);
  const resumable = FileSystem.createDownloadResumable(
    resolvedSourceUrl,
    destination,
    { headers: await authHeadersForUrl(resolvedSourceUrl) },
    (event) => {
      const progress = event?.totalBytesExpectedToWrite
        ? event.totalBytesWritten / event.totalBytesExpectedToWrite
        : 0;
      if (typeof onProgress === 'function') onProgress(progress);
    }
  );

  const result = await resumable.downloadAsync();
  const localUri = normalizeUri(result?.uri || destination);
  console.log('[MEDIA:DOWNLOAD:COMPLETE]', localUri);
  
  return localUri;
}

// Clean up old temp files
export const cleanupTempFiles = async (maxAge = 24 * 60 * 60 * 1000) => { // 24 hours
  try {
    const tempDir = THUMBNAIL_DIR;
    const dirInfo = await FileSystem.getInfoAsync(tempDir);
    
    if (!dirInfo.exists) return;

    const files = await FileSystem.readDirectoryAsync(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = `${tempDir}${file}`;
      const fileInfo = await FileSystem.getInfoAsync(filePath);
      
      if (fileInfo.exists && fileInfo.modificationTime) {
        const fileAge = now - (fileInfo.modificationTime * 1000);
        if (fileAge > maxAge) {
          await FileSystem.deleteAsync(filePath);
          console.log('🗑️ Deleted old temp file:', file);
        }
      }
    }
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
};

// Get file info
export const getFileInfo = async (uri) => {
  try {
    const normalized = normalizeUri(uri);
    const info = await FileSystem.getInfoAsync(normalized);
    
    if (!info.exists) {
      return null;
    }

    return {
      uri: normalized,
      size: info.size,
      exists: true,
      modificationTime: info.modificationTime
    };
  } catch (error) {
    console.error('❌ Get file info failed:', error);
    return null;
  }
};