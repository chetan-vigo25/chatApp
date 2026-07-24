import * as FileSystem from 'expo-file-system/legacy';
import mediaService, { isDownloadPausedError, isDownloadCancelledError } from './MediaService';
import localStorageService from './LocalStorageService';

export const MEDIA_DOWNLOAD_STATUS = {
  NOT_DOWNLOADED: 'NOT_DOWNLOADED',
  DOWNLOADING: 'DOWNLOADING',
  PAUSED: 'PAUSED',
  DOWNLOADED: 'DOWNLOADED',
  FAILED: 'FAILED',
};

const RETRY_LIMIT = 2;
const RETRY_DELAY_MS = 900;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (value?._id?.$oid) return String(value._id.$oid);
    const candidate = value?._id || value?.id || value?.mediaId || value?.messageId || value?.$oid || null;
    return candidate == null ? null : String(candidate);
  }
  return null;
};

const normalizeMessageType = (message = {}, mediaMeta = {}) => {
  const rawType = String(
    message?.fileCategory ||
    mediaMeta?.fileCategory ||
    message?.mediaType ||
    message?.type ||
    message?.messageType ||
    'file'
  ).toLowerCase();

  if (rawType === 'media') {
    return String(mediaMeta?.fileCategory || message?.fileCategory || 'file').toLowerCase();
  }

  if (rawType === 'document') return 'file';
  return rawType;
};

const resolveMediaIdentity = (message = {}) => {
  const mediaMeta = message?.mediaMeta || message?.payload?.mediaMeta || {};
  const payloadFile = message?.payload?.file || {};

  // Prefer the real media ID from upload; fall back to message ID only as last resort
  const realMediaId =
    normalizeId(message?.mediaId) ||
    normalizeId(mediaMeta?.mediaId) ||
    normalizeId(message?.payload?.mediaId) ||
    normalizeId(payloadFile?.mediaId);

  const messageId =
    normalizeId(message?.serverMessageId) ||
    normalizeId(message?.id) ||
    normalizeId(message?.messageId) ||
    normalizeId(message?.tempId);

  const mediaId = realMediaId || messageId;

  const mediaUrl =
    message?.mediaUrl ||
    message?.previewUrl ||
    message?.serverMediaUrl ||
    message?.url ||
    message?.payload?.mediaUrl ||
    message?.payload?.previewUrl ||
    payloadFile?.url ||
    payloadFile?.uri ||
    null;

  const mediaThumbnailUrl =
    message?.mediaThumbnailUrl ||
    message?.thumbnailUrl ||
    message?.serverPreviewUrl ||
    message?.previewUrl ||
    message?.payload?.mediaThumbnailUrl ||
    message?.payload?.thumbnailUrl ||
    mediaUrl ||
    null;

  return {
    mediaId,
    messageId,
    chatId: normalizeId(message?.chatId),
    groupId: normalizeId(message?.groupId),
    messageType: normalizeMessageType(message, mediaMeta),
    mediaUrl,
    mediaThumbnailUrl,
    mediaMeta,
  };
};

class MediaDownloadManager {
  listeners = new Set();
  inFlight = new Map();
  stateById = new Map();
  initialized = false;
  initPromise = null;

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('MediaDownloadManager listener failed:', error);
      }
    }
  }

  setState(mediaId, patch = {}) {
    if (!mediaId) return;
    const key = String(mediaId);
    const current = this.stateById.get(key) || {
      mediaId: key,
      status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
      progress: 0,
      localPath: null,
      error: null,
      updatedAt: Date.now(),
    };

    const next = {
      ...current,
      ...patch,
      mediaId: key,
      updatedAt: Date.now(),
    };

    this.stateById.set(key, next);
    this.emit({ type: 'state', mediaId: key, state: next });
  }

  getState(mediaId) {
    if (!mediaId) return null;
    return this.stateById.get(String(mediaId)) || null;
  }

  // Live snapshot of every tracked item. Downloads are OWNED by this
  // module-level manager and keep running across navigation — only the
  // screen-scoped React state resets on unmount. A remounting screen overlays
  // this snapshot over the persisted map so bubbles RE-ATTACH to in-flight
  // downloads (ring + real progress) instead of falling back to
  // NOT_DOWNLOADED until the next progress event.
  getAllStates() {
    const map = {};
    this.stateById.forEach((state, mediaId) => {
      map[String(mediaId)] = { ...state };
    });
    return map;
  }

  async rehydrate() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await localStorageService.init();

      const [allMedia, pending, paused] = await Promise.all([
        localStorageService.getMediaFilesByChat(),
        localStorageService.getPendingDownloads(),
        typeof localStorageService.getPausedDownloads === 'function'
          ? localStorageService.getPausedDownloads()
          : Promise.resolve([]),
      ]);

      allMedia.forEach((record = {}) => {
        const mediaId = normalizeId(record?.mediaId || record?.id || record?.serverMessageId);
        if (!mediaId) return;

        if (record?.localPath) {
          this.setState(mediaId, {
            status: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
            progress: 100,
            localPath: record.localPath,
            error: null,
          });
          return;
        }

        const status = String(record?.downloadStatus || '').toUpperCase();
        this.setState(mediaId, {
          status: status || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
          progress: Number(record?.downloadProgress || 0),
          localPath: null,
          error: record?.lastError || null,
        });
      });

      pending.forEach((item = {}) => {
        const mediaId = normalizeId(item?.mediaId);
        if (!mediaId) return;
        const queueStatus = String(item?.status || '').toLowerCase();

        if (queueStatus === 'downloading') {
          this.setState(mediaId, {
            status: MEDIA_DOWNLOAD_STATUS.DOWNLOADING,
            progress: Number(item?.progress || 0),
          });
        } else if (queueStatus === 'paused') {
          // Paused before the app was killed — keep it paused (the persisted
          // pause snapshot in MediaService resumes it when the user taps play).
          this.setState(mediaId, {
            status: MEDIA_DOWNLOAD_STATUS.PAUSED,
            progress: Number(item?.progress || 0),
          });
        } else if (queueStatus === 'failed') {
          this.setState(mediaId, {
            status: MEDIA_DOWNLOAD_STATUS.FAILED,
            progress: Number(item?.progress || 0),
            error: item?.error || 'download failed',
          });
        } else {
          this.setState(mediaId, {
            status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
            progress: 0,
          });
        }
      });

      (paused || []).forEach((item = {}) => {
        const mediaId = normalizeId(item?.mediaId);
        if (!mediaId) return;
        this.setState(mediaId, {
          status: MEDIA_DOWNLOAD_STATUS.PAUSED,
          progress: Number(item?.progress || 0),
        });
      });

      this.initialized = true;
      this.initPromise = null;
    })().catch((error) => {
      this.initPromise = null;
      throw error;
    });

    return this.initPromise;
  }

  async _getCachedLocalPath(mediaId) {
    const record = await localStorageService.getMediaFile(mediaId);
    if (!record?.localPath) return null;
    try {
      const info = await FileSystem.getInfoAsync(record.localPath);
      if (info?.exists) return record.localPath;
      return null;
    } catch {
      return null;
    }
  }

  async download(message = {}, options = {}) {
    await this.rehydrate();

    const identity = resolveMediaIdentity(message);
    const mediaId = identity.mediaId;
    if (!mediaId) {
      throw new Error('Missing mediaId for download');
    }

    const key = String(mediaId);
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const force = Boolean(options?.force);
    if (!force) {
      const localPath = await this._getCachedLocalPath(key);
      if (localPath) {
        this.setState(key, {
          status: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
          progress: 100,
          localPath,
          error: null,
        });
        return localPath;
      }
    }

    const run = (async () => {
      this.setState(key, {
        status: MEDIA_DOWNLOAD_STATUS.DOWNLOADING,
        progress: 0,
        localPath: null,
        error: null,
      });

      let finalError = null;

      for (let attempt = 0; attempt <= RETRY_LIMIT; attempt += 1) {
        try {
          const localPath = await mediaService.downloadToLocal({
            mediaId: key,
            chatId: options?.chatId || identity.chatId || message?.chatId,
            messageType: identity.messageType,
            filename: options?.filename || message?.text || message?.fileName || key,
            force,
            messageId: identity.messageId || message?.messageId || message?.serverMessageId || message?.id || null,
            groupId: identity.groupId || message?.groupId || null,
            mediaUrl: identity.mediaUrl || message?.mediaUrl || message?.previewUrl || message?.url || null,
            expectedSize: Number(identity.mediaMeta?.fileSize || 0) || null,
            expectedHash: identity.mediaMeta?.contentHash || null,
            onProgress: (progressPct) => {
              const normalized = Math.max(0, Math.min(100, Number(progressPct || 0)));
              this.setState(key, {
                status: MEDIA_DOWNLOAD_STATUS.DOWNLOADING,
                progress: normalized,
              });
              if (typeof options?.onProgress === 'function') {
                options.onProgress(normalized);
              }
            },
          });

          await localStorageService.upsertMediaFile({
            mediaId: key,
            id: key,
            chatId: options?.chatId || identity.chatId || message?.chatId,
            messageType: identity.messageType,
            localPath,
            serverUrl: identity.mediaUrl,
            thumbnailUrl: identity.mediaThumbnailUrl,
            metadata: identity.mediaMeta || {},
            downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
            downloadProgress: 100,
            downloadedAt: Date.now(),
            lastError: null,
            createdAtTs: Number(message?.timestamp || Date.now()),
          });

          this.setState(key, {
            status: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
            progress: 100,
            localPath,
            error: null,
          });

          // Auto-save to device gallery (WhatsApp-style visible folder)
          try {
            mediaService.saveToDeviceMedia(localPath, identity.messageType).catch(() => {});
          } catch {}

          return localPath;
        } catch (error) {
          // Intentional stop — NOT a failure. Keep progress for the paused
          // ring, don't retry, don't mark the media row FAILED.
          if (isDownloadPausedError(error)) {
            this.setState(key, {
              status: MEDIA_DOWNLOAD_STATUS.PAUSED,
              progress: Number(this.getState(key)?.progress || 0),
              error: null,
            });
            throw error;
          }
          if (isDownloadCancelledError(error)) {
            this.setState(key, {
              status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
              progress: 0,
              localPath: null,
              error: null,
            });
            throw error;
          }

          finalError = error;

          if (attempt < RETRY_LIMIT) {
            await wait(RETRY_DELAY_MS * (attempt + 1));
            continue;
          }
        }
      }

      const errorMessage = finalError?.message || 'download failed';

      await localStorageService.upsertMediaFile({
        mediaId: key,
        id: key,
        chatId: options?.chatId || identity.chatId || message?.chatId,
        messageType: identity.messageType,
        serverUrl: identity.mediaUrl,
        thumbnailUrl: identity.mediaThumbnailUrl,
        metadata: identity.mediaMeta || {},
        downloadStatus: MEDIA_DOWNLOAD_STATUS.FAILED,
        downloadProgress: Number(this.getState(key)?.progress || 0),
        downloadedAt: null,
        lastError: errorMessage,
        createdAtTs: Number(message?.timestamp || Date.now()),
      });

      this.setState(key, {
        status: MEDIA_DOWNLOAD_STATUS.FAILED,
        error: errorMessage,
      });

      throw finalError || new Error(errorMessage);
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, run);
    return run;
  }

  /**
   * Pause an in-flight download. MediaService.pauseDownload persists the
   * resumable state (resumeData + fileUri) so resume() continues from the
   * partial bytes — even after an app restart.
   */
  async pause(mediaId) {
    if (!mediaId) return false;
    const key = String(mediaId);
    const paused = await mediaService.pauseDownload(key);
    if (paused) {
      this.setState(key, {
        status: MEDIA_DOWNLOAD_STATUS.PAUSED,
        progress: Number(this.getState(key)?.progress || 0),
        error: null,
      });
    }
    return paused;
  }

  /**
   * Resume a paused download — just re-enter download(); downloadToLocal picks
   * up the persisted pause snapshot and calls resumeAsync() on it.
   */
  async resume(message = {}, options = {}) {
    return this.download(message, options);
  }

  /**
   * Cancel a paused/in-flight download: deletes the partial file + snapshot
   * and resets the item to the not-downloaded state (tap-to-download again).
   */
  async cancel(mediaId) {
    if (!mediaId) return;
    const key = String(mediaId);
    await mediaService.cancelDownload(key);
    this.setState(key, {
      status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
      progress: 0,
      localPath: null,
      error: null,
    });
  }

  async getCachedMediaMap() {
    await this.rehydrate();
    const allMedia = await localStorageService.getMediaFilesByChat();
    const map = {};

    allMedia.forEach((record = {}) => {
      const mediaId = normalizeId(record?.mediaId || record?.id || record?.serverMessageId);
      if (!mediaId) return;
      map[String(mediaId)] = {
        mediaId: String(mediaId),
        localPath: record?.localPath || null,
        downloadStatus:
          String(record?.downloadStatus || '').toUpperCase() ||
          (record?.localPath ? MEDIA_DOWNLOAD_STATUS.DOWNLOADED : MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED),
        downloadedAt: record?.downloadedAt || null,
      };
    });

    return map;
  }
}

const mediaDownloadManager = new MediaDownloadManager();

export { resolveMediaIdentity };
export default mediaDownloadManager;