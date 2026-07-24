import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { BACKEND_URL } from '@env';
import { apiCall } from '../Config/Https';
import localStorageService from './LocalStorageService';
import { toSecureMediaUri, mediaResolve } from '../utils/mediaService';
import { computeFileSha256, MAX_HASH_BYTES } from '../utils/fileHash';

const API_PREFIX = 'user/media';

const normalizeUri = (uri) => {
  if (!uri) return uri;
  if (/^(file|content|https?):\/\//i.test(uri)) return uri;
  return uri.startsWith('/') ? `file://${uri}` : uri;
};

const getFilenameFromUri = (uri, fallback = `media_${Date.now()}`) => {
  if (!uri) return fallback;
  const noQuery = uri.split('?')[0];
  const name = noQuery.split('/').pop();
  return name || fallback;
};

const buildAbsoluteUrl = (pathOrUrl) => {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!BACKEND_URL) return pathOrUrl;
  return `${BACKEND_URL.replace(/\/$/, '')}/${String(pathOrUrl).replace(/^\//, '')}`;
};

// Resolve a MEDIA file URL (not an API endpoint) for the current env.
// toSecureMediaUri absolutizes relative "/uploads/…" paths against the backend
// ORIGIN (buildAbsoluteUrl would wrongly join them under /api/v2/ → 404) and
// remaps URLs baked with a dev/LAN host (FILE_BASE_URL at upload time) onto the
// current backend, so media sent against a local env still loads on live.
const resolveMediaFileUrl = (pathOrUrl) => {
  if (!pathOrUrl) return null;
  const resolved = toSecureMediaUri(pathOrUrl);
  if (/^https?:\/\//i.test(resolved || '')) return resolved;
  // Not a recognized media path — fall back to the API-base join.
  return buildAbsoluteUrl(pathOrUrl);
};

// Persisted pause snapshots for received-media downloads — a map keyed by
// mediaId of { url, fileUri, resumeData, savedAt } (the DownloadPauseState
// from FileSystem.DownloadResumable.pauseAsync). Kept in AsyncStorage so a
// paused download survives an app kill and resumes from its partial bytes.
const PAUSED_DOWNLOAD_SNAPSHOT_KEY = 'media_download_paused_v1';

export const DOWNLOAD_PAUSED_MESSAGE = 'download paused';
export const DOWNLOAD_CANCELLED_MESSAGE = 'download cancelled';

export const isDownloadPausedError = (err) =>
  /download paused/i.test(String(err?.message || err || ''));
export const isDownloadCancelledError = (err) =>
  /download cancelled/i.test(String(err?.message || err || ''));

class MediaService {
  activeUploads = new Map();
  activeDownloads = new Map();
  // mediaId -> 'pause' | 'cancel' — set by pauseDownload/cancelDownload while a
  // task is in flight so downloadToLocal can tell an intentional stop apart
  // from a network failure.
  downloadStopRequests = new Map();

  async _readPausedDownloadMap() {
    try {
      const raw = await AsyncStorage.getItem(PAUSED_DOWNLOAD_SNAPSHOT_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async _writePausedDownloadMap(map) {
    try {
      await AsyncStorage.setItem(PAUSED_DOWNLOAD_SNAPSHOT_KEY, JSON.stringify(map || {}));
    } catch { /* best-effort */ }
  }

  async _setPausedDownloadSnapshot(mediaId, snapshot) {
    if (!mediaId || !snapshot?.url || !snapshot?.fileUri) return;
    const map = await this._readPausedDownloadMap();
    map[String(mediaId)] = {
      url: snapshot.url,
      fileUri: snapshot.fileUri,
      resumeData: snapshot.resumeData || null,
      savedAt: Date.now(),
    };
    await this._writePausedDownloadMap(map);
  }

  async getPausedDownloadSnapshot(mediaId) {
    if (!mediaId) return null;
    const map = await this._readPausedDownloadMap();
    return map[String(mediaId)] || null;
  }

  async _removePausedDownloadSnapshot(mediaId) {
    if (!mediaId) return;
    const map = await this._readPausedDownloadMap();
    if (map[String(mediaId)]) {
      delete map[String(mediaId)];
      await this._writePausedDownloadMap(map);
    }
  }

  // Delete a paused download's partial file + its snapshot (cancel path).
  async discardPausedDownload(mediaId) {
    const snapshot = await this.getPausedDownloadSnapshot(mediaId);
    if (snapshot?.fileUri) {
      try { await FileSystem.deleteAsync(snapshot.fileUri, { idempotent: true }); } catch { /* best-effort */ }
    }
    await this._removePausedDownloadSnapshot(mediaId);
  }

  isDownloadInFlight(mediaId) {
    return this.activeDownloads.has(String(mediaId));
  }

  /**
   * Pause an in-flight download. pauseAsync() stops the bytes and returns the
   * resumable state ({url, fileUri, resumeData}) which is persisted so the
   * download can resume — even after an app restart. The pending
   * downloadToLocal() promise rejects with 'download paused'.
   */
  async pauseDownload(mediaId) {
    const key = String(mediaId);
    const task = this.activeDownloads.get(key);
    if (!task) return false;

    this.downloadStopRequests.set(key, 'pause');
    try {
      const snapshot = await task.pauseAsync();
      const savable = snapshot || (typeof task.savable === 'function' ? task.savable() : null);
      if (savable?.url && savable?.fileUri) {
        await this._setPausedDownloadSnapshot(key, savable);
      }
      await localStorageService.updateDownloadQueue(key, { status: 'paused' }).catch(() => {});
      return true;
    } catch {
      this.downloadStopRequests.delete(key);
      return false;
    }
  }

  async uploadMedia({ file, chatId, messageType, onProgress }) {
    if (!file?.uri) throw new Error('Invalid file payload');

    const token = await AsyncStorage.getItem('accessToken');
    const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const endpoint = buildAbsoluteUrl(`${API_PREFIX}/upload`);

    console.log('[MEDIA:UPLOAD:START]', {
      uploadId,
      name: file?.name,
      size: file?.size,
      type: messageType,
      chatId,
    });

    const formData = new FormData();
    formData.append('file', {
      uri: normalizeUri(file.uri),
      name: file.name || getFilenameFromUri(file.uri),
      type: file.type || 'application/octet-stream',
    });
    if (chatId) formData.append('chatId', chatId);
    if (messageType) formData.append('messageType', messageType);

    const xhr = new XMLHttpRequest();
    this.activeUploads.set(uploadId, xhr);

    const response = await new Promise((resolve, reject) => {
      xhr.open('POST', endpoint);
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }

      xhr.upload.onprogress = (event) => {
        if (!event?.total) return;
        const percent = Math.max(0, Math.min(100, (event.loaded / event.total) * 100));
        console.log('[MEDIA:UPLOAD:PROGRESS]', { uploadId, percent });
        if (typeof onProgress === 'function') onProgress(percent);
      };

      xhr.onerror = () => reject(new Error('Upload request failed'));
      xhr.onabort = () => reject(new Error('Upload aborted'));
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        try {
          const parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed?.message || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error('Invalid upload response'));
        }
      };

      xhr.send(formData);
    });

    this.activeUploads.delete(uploadId);
    console.log('[MEDIA:UPLOAD:COMPLETE]', response?.data || response);
    return response;
  }

  cancelUpload(uploadId) {
    const xhr = this.activeUploads.get(uploadId);
    if (xhr) {
      xhr.abort();
      this.activeUploads.delete(uploadId);
    }
  }

  async fetchAllFiles({ category = null, chatId = null, page = 1, limit = 20, groupByCategory = false } = {}) {
    const payload = { category, chatId, page, limit, groupByCategory };
    console.log('[MEDIA:GALLERY:LOAD]', payload);
    return apiCall('POST', `${API_PREFIX}/all/files`, payload);
  }

  async viewMedia(id) {
    return apiCall('POST', `${API_PREFIX}/view`, { id });
  }

  async deleteMedia(id) {
    return apiCall('POST', `${API_PREFIX}/delete`, { id });
  }

  async getDownloadUrl(mediaId, chatId = null, extra = {}) {
    const payload = { mediaId };
    if (chatId) payload.chatId = chatId;
    if (extra.messageId) payload.messageId = extra.messageId;
    if (extra.groupId) payload.groupId = extra.groupId;
    if (!extra.messageId && mediaId) {
      payload.messageId = payload.messageId || mediaId;
    }
    console.log('=== MEDIA DOWNLOAD REQUEST ===', JSON.stringify(payload));
    // Silent mode — don't show toast on 404, direct URL fallback handles it
    const result = await apiCall('POST', `${API_PREFIX}/download`, payload, { silent: true });
    console.log('=== MEDIA DOWNLOAD RESPONSE ===', JSON.stringify(result));
    return result;
  }

  /**
   * Silent version — returns null instead of throwing on failure.
   * Used during download to avoid toast flashing when the API fails
   * but a direct URL fallback is available.
   */
  async getDownloadUrlSilent(mediaId, chatId = null, extra = {}) {
    try {
      return await this.getDownloadUrl(mediaId, chatId, extra);
    } catch {
      return null;
    }
  }

  async downloadToLocal({ mediaId, chatId, messageType, filename, onProgress, force = false, messageId = null, groupId = null, mediaUrl = null, expectedSize = null, expectedHash = null }) {
    if (!mediaId) throw new Error('mediaId is required');

    const existing = await localStorageService.getMediaFile(mediaId);
    if (!force && existing?.localPath) {
      const exists = await FileSystem.getInfoAsync(existing.localPath);
      if (exists.exists) {
        console.log('[MEDIA:CACHE:HIT]', { mediaId, localPath: existing.localPath });
        return existing.localPath;
      }
    }

    console.log('[MEDIA:CACHE:MISS]', mediaId);

    let downloadUrl = null;

    // Try the download API first — uses silent version to avoid error toasts
    // when it fails for group media (where mediaId is actually a messageId).
    const signed = await this.getDownloadUrlSilent(mediaId, chatId, { messageId, groupId });
    // Resolve for the CURRENT env — the server-returned URL is baked from
    // FILE_BASE_URL at upload time and may be relative or point at a LAN host.
    downloadUrl = resolveMediaFileUrl(signed?.data?.downloadUrl || signed?.downloadUrl || null);

    // Fallback: use the direct media URL from the message (common for group media)
    if (!downloadUrl && mediaUrl) {
      downloadUrl = resolveMediaFileUrl(mediaUrl);
      console.log('[MEDIA:DOWNLOAD:DIRECT_URL]', downloadUrl);
    }

    if (!downloadUrl) {
      throw new Error('Download URL not available');
    }

    const safeName = filename || `${mediaId}`;
    const destination = await localStorageService.buildMediaPath({
      mediaId,
      chatId,
      filename: safeName,
      messageType,
    });

    // Persist mediaUrl/messageId/groupId on the queue row so an interrupted
    // download can be resumed after an app restart (DownloadQueue.hydratePending).
    await localStorageService.queueDownload(mediaId, {
      chatId,
      messageType,
      filename: safeName,
      mediaUrl: mediaUrl || null,
      messageId: messageId || null,
      groupId: groupId || null,
    });
    await localStorageService.updateDownloadQueue(mediaId, { status: 'downloading', progress: 0 });

    // Storage gate — refuse to start a download that can't fit (keep 50MB headroom)
    // and surface a clear 'storage full' error instead of a generic failure.
    try {
      if (typeof FileSystem.getFreeDiskStorageAsync === 'function') {
        const freeBytes = Number(await FileSystem.getFreeDiskStorageAsync() || 0);
        const neededBytes = Number(expectedSize || 0) + 50 * 1024 * 1024;
        if (freeBytes > 0 && freeBytes < neededBytes) {
          await localStorageService.updateDownloadQueue(mediaId, {
            status: 'failed',
            progress: 0,
            error: 'storage full',
          }).catch(() => {});
          throw new Error('storage full — free up space to download this media');
        }
      }
    } catch (err) {
      if (/storage full/i.test(String(err?.message || ''))) throw err;
      // Free-space probe unavailable — proceed with the download.
    }

    // Auth token for OUR backend's media URLs (they require a JWT Bearer). It is
    // decided PER-URL: a presigned S3 URL already carries its credentials in the
    // query string (X-Amz-Signature), and adding an Authorization header on top
    // makes S3 reject the request with 400 ("only one auth mechanism allowed") —
    // which is why the same URL downloaded in a browser (no header) but 400'd in
    // the app (Bearer header). Send the header ONLY to non-presigned (own-origin)
    // URLs.
    let authToken = null;
    try { authToken = await AsyncStorage.getItem('accessToken'); } catch {}
    const headersForUrl = (url) => {
      const isPresigned = /[?&](X-Amz-Signature|X-Amz-Credential)=/i.test(String(url || ''));
      return authToken && !isPresigned ? { Authorization: `Bearer ${authToken}` } : {};
    };

    const downloadKey = String(mediaId);
    const onTaskProgress = (event) => {
      const total = Number(event?.totalBytesExpectedToWrite || 0);
      const written = Number(event?.totalBytesWritten || 0);
      const progress = total > 0 ? (written / total) * 100 : 0;
      if (typeof onProgress === 'function') onProgress(progress);
      localStorageService.updateDownloadQueue(mediaId, { status: 'downloading', progress }).catch(() => {});
    };

    // Run a resumable task and translate an intentional pause/cancel into a
    // distinctive error (callers must not treat it as a failure/retry).
    const runTask = async (task, mode) => {
      this.activeDownloads.set(downloadKey, task);
      let result = null;
      let taskError = null;
      try {
        result = mode === 'resume' ? await task.resumeAsync() : await task.downloadAsync();
      } catch (err) {
        taskError = err;
      } finally {
        this.activeDownloads.delete(downloadKey);
      }

      const stopRequest = this.downloadStopRequests.get(downloadKey);
      this.downloadStopRequests.delete(downloadKey);
      if (stopRequest === 'cancel') throw new Error(DOWNLOAD_CANCELLED_MESSAGE);
      if (stopRequest === 'pause') throw new Error(DOWNLOAD_PAUSED_MESSAGE);
      if (taskError) throw taskError;
      // pauseAsync can settle downloadAsync with an empty result on some
      // platforms — never treat that as a completed download.
      if (!result) throw new Error(DOWNLOAD_PAUSED_MESSAGE);
      return { localPath: result?.uri || destination, httpStatus: Number(result?.status || 0) };
    };

    const attemptDownload = async (url) =>
      runTask(
        FileSystem.createDownloadResumable(url, destination, { headers: headersForUrl(url) }, onTaskProgress),
        'download'
      );

    console.log('[MEDIA:DOWNLOAD:START]', mediaId);
    let localPath;
    let httpStatus;

    // A persisted pause snapshot means this download was paused earlier —
    // resume from its partial bytes instead of starting over. If the resume
    // fails for any reason other than another pause/cancel (expired signed
    // URL, evicted partial file), fall back to a fresh full download.
    const pausedSnapshot = await this.getPausedDownloadSnapshot(mediaId);
    if (pausedSnapshot?.url && pausedSnapshot?.fileUri) {
      try {
        const resumeTask = FileSystem.createDownloadResumable(
          pausedSnapshot.url,
          pausedSnapshot.fileUri,
          { headers: headersForUrl(pausedSnapshot.url) },
          onTaskProgress,
          pausedSnapshot.resumeData || undefined
        );
        ({ localPath, httpStatus } = await runTask(resumeTask, 'resume'));
        await this._removePausedDownloadSnapshot(mediaId);
      } catch (err) {
        if (isDownloadPausedError(err) || isDownloadCancelledError(err)) throw err;
        await this.discardPausedDownload(mediaId);
        localPath = undefined;
        httpStatus = undefined;
      }
    }

    if (localPath === undefined) {
      ({ localPath, httpStatus } = await attemptDownload(downloadUrl));
    }

    // Stale / malformed signed URL (400/401/403/410) — ask the server for a
    // fresh one via user/media/resolve and retry ONCE before failing. 400 is
    // included because a signed URL whose query (e.g. a bad content-disposition)
    // doesn't match its signature comes back as a 400 Bad Request from S3, and
    // the freshly-resolved inline URL carries no such disposition.
    if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 410) {
      try { await FileSystem.deleteAsync(localPath, { idempotent: true }); } catch { /* best-effort */ }
      const resolveId = String(messageId || mediaId);
      const resolved = await mediaResolve([resolveId]);
      const entry = resolved?.[resolveId] || resolved?.[String(mediaId)] || null;
      const freshRaw =
        entry?.mediaUrl ||
        entry?.previewUrl ||
        (Array.isArray(entry?.items) ? (entry.items[0]?.mediaUrl || entry.items[0]?.previewUrl) : null);
      const freshUrl = freshRaw ? resolveMediaFileUrl(freshRaw) : null;
      if (freshUrl) {
        console.log('[MEDIA:DOWNLOAD:RESOLVE_RETRY]', { mediaId, httpStatus });
        ({ localPath, httpStatus } = await attemptDownload(freshUrl));
      }
    }

    // downloadAsync saves the response body regardless of HTTP status — a
    // 404/403 error page written as ".jpg" renders as a permanent black
    // preview (and the cache-hit path would serve it forever). Treat non-2xx
    // as failure and remove the poisoned file.
    if (httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
      try { await FileSystem.deleteAsync(localPath, { idempotent: true }); } catch { /* best-effort */ }
      await localStorageService.updateDownloadQueue(mediaId, {
        status: 'failed',
        progress: 0,
        error: `HTTP ${httpStatus}`,
      }).catch(() => {});
      console.log('[MEDIA:DOWNLOAD:HTTP_ERROR]', { mediaId, httpStatus, downloadUrl });
      throw new Error(`Download failed (HTTP ${httpStatus})`);
    }

    // Integrity checks: content hash is authoritative when we can compute it
    // (≤16MB); byte size is the cheap fallback when no hash is available.
    const failIntegrity = async (reason) => {
      try { await FileSystem.deleteAsync(localPath, { idempotent: true }); } catch { /* best-effort */ }
      await localStorageService.updateDownloadQueue(mediaId, {
        status: 'failed',
        progress: 0,
        error: reason,
      }).catch(() => {});
      console.log('[MEDIA:DOWNLOAD:INTEGRITY_FAIL]', { mediaId, reason });
      throw new Error(`Download failed (${reason})`);
    };

    try {
      const expectedHashHex = expectedHash ? String(expectedHash).toLowerCase() : null;
      let hashVerified = false;
      if (expectedHashHex) {
        const actualHash = await computeFileSha256(localPath, { maxBytes: MAX_HASH_BYTES });
        if (actualHash && actualHash.toLowerCase() !== expectedHashHex) {
          await failIntegrity('content hash mismatch');
        }
        hashVerified = Boolean(actualHash);
      }
      if (!hashVerified && Number(expectedSize || 0) > 0) {
        const info = await FileSystem.getInfoAsync(localPath, { size: true });
        const actualSize = Number(info?.size || 0);
        if (actualSize > 0 && actualSize !== Number(expectedSize)) {
          await failIntegrity(`size mismatch (${actualSize} != ${expectedSize})`);
        }
      }
    } catch (err) {
      if (/Download failed/i.test(String(err?.message || ''))) throw err;
      // Verification tooling failed (not the file) — keep the download.
    }

    await localStorageService.updateDownloadQueue(mediaId, {
      status: 'completed',
      progress: 100,
      localPath,
      completedAt: Date.now(),
    });

    console.log('[MEDIA:DOWNLOAD:COMPLETE]', { mediaId, localPath });
    return localPath;
  }

  /**
   * Cancel a download entirely: stop in-flight bytes, delete the partial file
   * (active destination and/or paused snapshot) and reset the queue row so the
   * bubble returns to the not-downloaded state.
   */
  async cancelDownload(mediaId) {
    const key = String(mediaId);
    const task = this.activeDownloads.get(key);
    if (task) {
      this.downloadStopRequests.set(key, 'cancel');
      let partialUri = null;
      try {
        const snapshot = await task.pauseAsync();
        partialUri = snapshot?.fileUri || (typeof task.savable === 'function' ? task.savable()?.fileUri : null);
      } catch { /* task may already be settled */ }
      if (partialUri) {
        try { await FileSystem.deleteAsync(partialUri, { idempotent: true }); } catch { /* best-effort */ }
      }
    }
    await this.discardPausedDownload(key);
    await localStorageService.updateDownloadQueue(key, { status: 'cancelled', progress: 0 }).catch(() => {});
  }

  async persistMediaRecord({
    mediaId,
    chatId,
    localPath,
    previewUrl,
    thumbnailUrl,
    messageType,
    metadata,
  }) {
    const payload = {
      mediaId: String(mediaId),
      id: String(mediaId),
      chatId,
      localPath,
      serverUrl: resolveMediaFileUrl(previewUrl),
      thumbnailUrl: resolveMediaFileUrl(thumbnailUrl),
      messageType,
      metadata: metadata || {},
      createdAtTs: Date.now(),
    };

    console.log('[MEDIA:LOCAL:SAVE]', payload);
    return localStorageService.upsertMediaFile(payload);
  }

  /**
   * After downloading, save a copy to device's visible media folder.
   * This makes the file appear in:
   *   - Android: internal storage/Android/media/com.chat.baatCheet/TalksTry/Media/TalksTry Images/
   *   - Also visible in Gallery app and file manager
   *
   * WhatsApp equivalent:
   *   internal storage/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/
   */
  async saveToDeviceMedia(localPath, messageType) {
    if (!localPath) return null;
    if (Platform.OS !== 'android') return null; // iOS auto-handles via media library

    try {
      // Check file exists
      const info = await FileSystem.getInfoAsync(localPath);
      if (!info.exists) return null;

      const type = (messageType || '').toLowerCase();
      const isMediaType = type === 'image' || type === 'photo' || type === 'video';

      if (!isMediaType) return null; // only save images/videos to gallery

      // Check existing permission — only proceed if already granted
      // Do NOT prompt during auto-download; user can save to gallery manually
      const { status } = await MediaLibrary.getPermissionsAsync();
      if (status !== 'granted') return null;

      // Save to media library — this creates the file in:
      // /storage/emulated/0/Android/media/com.chat.baatCheet/
      const asset = await MediaLibrary.createAssetAsync(localPath);

      // Create album with WhatsApp-style name
      const albumName = type === 'video' ? 'TalksTry Video' : 'TalksTry Images';
      const album = await MediaLibrary.getAlbumAsync(albumName);

      if (album) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      } else {
        await MediaLibrary.createAlbumAsync(albumName, asset, false);
      }

      console.log('[MEDIA:GALLERY:SAVED]', { albumName, uri: asset.uri });
      return asset.uri;
    } catch (err) {
      // Non-critical — file is still in app storage
      console.warn('[MEDIA:GALLERY:FAIL]', err?.message);
      return null;
    }
  }
}

export default new MediaService();