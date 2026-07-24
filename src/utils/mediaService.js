// utils/mediaService.js
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { Platform, Alert, Linking } from 'react-native';
import { apiCall } from '../Config/Https';
import { BACKEND_URL } from '@env';
import { uploadFileInChunks, CHUNKED_UPLOAD_THRESHOLD } from './chunkedUpload';

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
  if (BACKEND_ORIGIN && /^\/?uploads\//i.test(u)) {
    return `${BACKEND_ORIGIN}${u.startsWith('/') ? '' : '/'}${u}`;
  }

  // Absolute URL pointing at OUR media (/uploads/) on a dev/LAN host that is
  // NOT the current backend → remap onto the current backend origin so media
  // sent against a local env still loads on the live env (and vice versa).
  const absMatch = u.match(/^https?:\/\/([^/:]+)(?::\d+)?(\/uploads\/.*)$/i);
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

// Request permissions — checks existing permission first, only prompts if undetermined
let _mediaPermissionGranted = false;
export const requestStoragePermission = async () => {
  // Skip system call entirely if we already know permission is granted (session cache)
  if (_mediaPermissionGranted) return true;

  try {
    // Check existing permission first — no dialog shown
    const existing = await MediaLibrary.getPermissionsAsync();
    if (existing.status === 'granted' || existing.status === 'limited') {
      _mediaPermissionGranted = true;
      return true;
    }

    // Only prompt if permission hasn't been decided yet (undetermined)
    // If user previously denied, don't keep asking — return false
    if (existing.status === 'denied' && !existing.canAskAgain) {
      return false;
    }

    // First-time ask or user can be asked again
    const { status } = await MediaLibrary.requestPermissionsAsync();
    const granted = status === 'granted' || status === 'limited';
    if (granted) _mediaPermissionGranted = true;
    return granted;
  } catch {
    return false;
  }
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

// Copy file to app folder
export const copyToAppFolder = async (inputUri, suggestedName = null, destDir = SENT_DIR, onProgress = null) => {
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

    const destination = `${destDir}${filename}`;

    console.log('📋 Copying file:', {
      from: normalizedUri.substring(0, 50) + '...',
      to: destination,
      type: destDir.includes('Images') ? 'image' : destDir.includes('Videos') ? 'video' : 'document'
    });

    // Handle remote URLs
    if (/^https?:\/\//i.test(normalizedUri)) {
      const downloadResumable = FileSystem.createDownloadResumable(
        toSecureMediaUri(normalizedUri),
        destination,
        {},
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

    // Handle content URIs
    if (/^content:\/\//i.test(normalizedUri)) {
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

    const downloadResumable = FileSystem.createDownloadResumable(
      toSecureMediaUri(remoteUrl),
      destination,
      {},
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

// Save file to media library
export const saveFileToMediaLibrary = async (localUri, albumName = APP_FOLDER) => {
  try {
    if (!localUri) return null;
    
    const hasPermission = await requestStoragePermission();
    if (!hasPermission) {
      console.log('⚠️ No media library permission');
      return null;
    }

    const normalized = normalizeUri(localUri);
    const asset = await MediaLibrary.createAssetAsync(normalized);
    
    try {
      const album = await MediaLibrary.getAlbumAsync(albumName);
      if (album) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      } else {
        await MediaLibrary.createAlbumAsync(albumName, asset, false);
      }
    } catch (albumErr) {
      console.warn('Album creation failed:', albumErr);
    }
    
    return asset;
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
    const response = await apiCall('POST', 'user/media/exists', { hash, fileName, chatId }, { silent: true });
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
  chunkSession = null,
  onChunkSession = null,
  timeoutMs = null,
  signal = null,
  isPaused = null,
}) => {
  try {
    if (!file || !dispatch || !mediaUploadAction) {
      throw new Error('Missing params for uploadMediaFile');
    }

    // Ensure file is in app folder first
    const persistentUri = await copyToAppFolder(file.uri, file.name, SENT_DIR);
    if (!persistentUri || typeof persistentUri !== 'string') {
      throw new Error('Invalid local file URI for upload');
    }

    if (!persistentUri.startsWith('file://') && !persistentUri.startsWith('content://')) {
      throw new Error(`Unsupported upload URI format: ${persistentUri}`);
    }

    // Dedupe: skip the upload entirely when the server already has these bytes.
    if (sourceHash) {
      const existing = await mediaExistsByHash({ hash: sourceHash, fileName: file.name || null, chatId });
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
    }

    // Large files go through the resumable chunked-session endpoints instead
    // of a single multipart POST (which can't survive a connection drop).
    const fileSize = Number(file.size || 0);
    if (fileSize > CHUNKED_UPLOAD_THRESHOLD) {
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
          const persistentUri = await copyToAppFolder(file.uri, file.name, SENT_DIR);
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
  
  const resumable = FileSystem.createDownloadResumable(
    toSecureMediaUri(sourceUrl),
    destination,
    {},
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