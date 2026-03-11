import * as FileSystem from 'expo-file-system/legacy';
import mediaService from './MediaService';
import localStorageService from './LocalStorageService';

export const MEDIA_DOWNLOAD_STATUS = {
  NOT_DOWNLOADED: 'NOT_DOWNLOADED',
  DOWNLOADING: 'DOWNLOADING',
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
  const mediaId =
    normalizeId(message?.mediaId) ||
    normalizeId(mediaMeta?.mediaId) ||
    normalizeId(message?.serverMessageId) ||
    normalizeId(message?.id) ||
    normalizeId(message?.tempId);

  const mediaUrl =
    message?.mediaUrl ||
    message?.previewUrl ||
    message?.serverMediaUrl ||
    message?.url ||
    null;

  const mediaThumbnailUrl =
    message?.mediaThumbnailUrl ||
    message?.thumbnailUrl ||
    message?.serverPreviewUrl ||
    message?.previewUrl ||
    mediaUrl ||
    null;

  return {
    mediaId,
    chatId: normalizeId(message?.chatId),
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

  async rehydrate() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await localStorageService.init();

      const [allMedia, pending] = await Promise.all([
        localStorageService.getMediaFilesByChat(),
        localStorageService.getPendingDownloads(),
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

          return localPath;
        } catch (error) {
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