import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

const KEY_PREFIX = 'media_v2';
const KEY_MEDIA_FILES = `${KEY_PREFIX}:media_files`;
const KEY_THUMBNAILS = `${KEY_PREFIX}:thumbnails_cache`;
const KEY_DOWNLOAD_QUEUE = `${KEY_PREFIX}:download_queue`;
const KEY_PENDING_UPLOADS = `${KEY_PREFIX}:pending_uploads`;

const APP_MEDIA_ROOT = `${FileSystem.documentDirectory}baatCheet/media/`;
const APP_MEDIA_IMAGES = `${APP_MEDIA_ROOT}images/`;
const APP_MEDIA_VIDEOS = `${APP_MEDIA_ROOT}videos/`;
const APP_MEDIA_DOCUMENTS = `${APP_MEDIA_ROOT}documents/`;
const APP_MEDIA_THUMBNAILS = `${APP_MEDIA_ROOT}cache/thumbnails/`;

const safeJsonParse = (raw, fallback) => {
  try {
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const ensureDir = async (dirPath) => {
  const info = await FileSystem.getInfoAsync(dirPath);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
  }
};

class LocalStorageService {
    /**
     * Hydrate downloaded media from persistent storage, verify file existence, remove stale DB entries.
     * Returns a map of valid downloaded media { mediaId: localPath }
     */
    async hydrateDownloadedMedia() {
      await this.init();
      const mediaMap = await this._readObject(KEY_MEDIA_FILES);
      const validMedia = {};
      let changed = false;
      for (const [mediaId, record] of Object.entries(mediaMap)) {
        if (record?.localPath) {
          try {
            const info = await FileSystem.getInfoAsync(record.localPath);
            if (info.exists) {
              validMedia[mediaId] = record.localPath;
            } else {
              // Remove stale entry
              delete mediaMap[mediaId];
              changed = true;
            }
          } catch (err) {
            delete mediaMap[mediaId];
            changed = true;
          }
        }
      }
      if (changed) {
        await this._writeObject(KEY_MEDIA_FILES, mediaMap);
      }
      return validMedia;
    }
  _initialized = false;

  async init() {
    if (this._initialized) return;

    await ensureDir(APP_MEDIA_ROOT);
    await ensureDir(APP_MEDIA_IMAGES);
    await ensureDir(APP_MEDIA_VIDEOS);
    await ensureDir(APP_MEDIA_DOCUMENTS);
    await ensureDir(APP_MEDIA_THUMBNAILS);

    const [mediaRaw, thumbRaw, queueRaw, pendingRaw] = await Promise.all([
      AsyncStorage.getItem(KEY_MEDIA_FILES),
      AsyncStorage.getItem(KEY_THUMBNAILS),
      AsyncStorage.getItem(KEY_DOWNLOAD_QUEUE),
      AsyncStorage.getItem(KEY_PENDING_UPLOADS),
    ]);

    if (!mediaRaw) await AsyncStorage.setItem(KEY_MEDIA_FILES, JSON.stringify({}));
    if (!thumbRaw) await AsyncStorage.setItem(KEY_THUMBNAILS, JSON.stringify({}));
    if (!queueRaw) await AsyncStorage.setItem(KEY_DOWNLOAD_QUEUE, JSON.stringify({}));
    if (!pendingRaw) await AsyncStorage.setItem(KEY_PENDING_UPLOADS, JSON.stringify({}));

    this._initialized = true;
  }

  async _readObject(key) {
    await this.init();
    const raw = await AsyncStorage.getItem(key);
    return safeJsonParse(raw, {});
  }

  async _writeObject(key, value) {
    await this.init();
    await AsyncStorage.setItem(key, JSON.stringify(value || {}));
  }

  async getMediaRootByType(messageType) {
    const type = (messageType || '').toLowerCase();
    if (type === 'image' || type === 'photo') return APP_MEDIA_IMAGES;
    if (type === 'video') return APP_MEDIA_VIDEOS;
    return APP_MEDIA_DOCUMENTS;
  }

  async buildMediaPath({ mediaId, chatId, filename, messageType }) {
    const root = await this.getMediaRootByType(messageType);
    const chatDir = `${root}${chatId || 'general'}/`;
    await ensureDir(chatDir);

    const base = filename || `${mediaId || Date.now()}`;
    return `${chatDir}${base}`;
  }

  async upsertMediaFile(record) {
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const key = String(record?.id || record?.mediaId || record?.serverMessageId || Date.now());

    mediaMap[key] = {
      ...(mediaMap[key] || {}),
      ...record,
      mediaId: key,
      updatedAt: Date.now(),
    };

    await this._writeObject(KEY_MEDIA_FILES, mediaMap);
    return mediaMap[key];
  }

  async getMediaFile(mediaId) {
    if (!mediaId) return null;
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    return mediaMap[String(mediaId)] || null;
  }

  async getMediaFilesByChat(chatId) {
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const all = Object.values(mediaMap || {});
    return all
      .filter((item) => !chatId || String(item?.chatId) === String(chatId))
      .sort((a, b) => Number(b?.createdAtTs || b?.updatedAt || 0) - Number(a?.createdAtTs || a?.updatedAt || 0));
  }

  async removeMediaFile(mediaId) {
    if (!mediaId) return;
    const key = String(mediaId);
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const thumbnails = await this._readObject(KEY_THUMBNAILS);
    const queue = await this._readObject(KEY_DOWNLOAD_QUEUE);

    const record = mediaMap[key];
    if (record?.localPath) {
      const info = await FileSystem.getInfoAsync(record.localPath);
      if (info.exists) {
        await FileSystem.deleteAsync(record.localPath, { idempotent: true });
      }
    }

    const thumbPath = thumbnails[key]?.path;
    if (thumbPath) {
      const info = await FileSystem.getInfoAsync(thumbPath);
      if (info.exists) {
        await FileSystem.deleteAsync(thumbPath, { idempotent: true });
      }
    }

    delete mediaMap[key];
    delete thumbnails[key];
    delete queue[key];

    await Promise.all([
      this._writeObject(KEY_MEDIA_FILES, mediaMap),
      this._writeObject(KEY_THUMBNAILS, thumbnails),
      this._writeObject(KEY_DOWNLOAD_QUEUE, queue),
    ]);
  }

  async saveThumbnail(mediaId, sourceUri) {
    if (!mediaId || !sourceUri) return null;
    const key = String(mediaId);
    const safePath = `${APP_MEDIA_THUMBNAILS}${key}.webp`;

    await ensureDir(APP_MEDIA_THUMBNAILS);
    await FileSystem.copyAsync({ from: sourceUri, to: safePath });

    const thumbnailMap = await this._readObject(KEY_THUMBNAILS);
    thumbnailMap[key] = {
      mediaId: key,
      path: safePath,
      timestamp: Date.now(),
    };
    await this._writeObject(KEY_THUMBNAILS, thumbnailMap);
    return safePath;
  }

  async getThumbnail(mediaId) {
    if (!mediaId) return null;
    const thumbnailMap = await this._readObject(KEY_THUMBNAILS);
    const hit = thumbnailMap[String(mediaId)] || null;
    return hit?.path || null;
  }

  async queueDownload(mediaId, payload = {}) {
    if (!mediaId) return;
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    queueMap[String(mediaId)] = {
      mediaId: String(mediaId),
      status: 'pending',
      progress: 0,
      retries: 0,
      createdAt: Date.now(),
      ...payload,
    };
    await this._writeObject(KEY_DOWNLOAD_QUEUE, queueMap);
  }

  async updateDownloadQueue(mediaId, patch = {}) {
    if (!mediaId) return;
    const key = String(mediaId);
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    queueMap[key] = {
      ...(queueMap[key] || { mediaId: key }),
      ...patch,
      updatedAt: Date.now(),
    };
    await this._writeObject(KEY_DOWNLOAD_QUEUE, queueMap);
  }

  async getDownloadQueueItem(mediaId) {
    if (!mediaId) return null;
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    return queueMap[String(mediaId)] || null;
  }

  async getPendingDownloads() {
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    return Object.values(queueMap || {})
      .filter((item) => ['pending', 'downloading', 'failed'].includes(item?.status))
      .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
  }

  async removeFromDownloadQueue(mediaId) {
    if (!mediaId) return;
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    delete queueMap[String(mediaId)];
    await this._writeObject(KEY_DOWNLOAD_QUEUE, queueMap);
  }

  async queuePendingUpload(uploadId, payload = {}) {
    if (!uploadId) return;
    const uploads = await this._readObject(KEY_PENDING_UPLOADS);
    uploads[String(uploadId)] = {
      uploadId: String(uploadId),
      status: 'pending',
      retries: 0,
      createdAt: Date.now(),
      ...payload,
    };
    await this._writeObject(KEY_PENDING_UPLOADS, uploads);
  }

  async updatePendingUpload(uploadId, patch = {}) {
    if (!uploadId) return;
    const uploads = await this._readObject(KEY_PENDING_UPLOADS);
    const key = String(uploadId);
    uploads[key] = {
      ...(uploads[key] || { uploadId: key }),
      ...patch,
      updatedAt: Date.now(),
    };
    await this._writeObject(KEY_PENDING_UPLOADS, uploads);
  }

  async getPendingUploads() {
    const uploads = await this._readObject(KEY_PENDING_UPLOADS);
    return Object.values(uploads || {})
      .filter((item) => ['pending', 'uploading', 'failed'].includes(item?.status))
      .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
  }

  async removePendingUpload(uploadId) {
    if (!uploadId) return;
    const uploads = await this._readObject(KEY_PENDING_UPLOADS);
    delete uploads[String(uploadId)];
    await this._writeObject(KEY_PENDING_UPLOADS, uploads);
  }

  async cleanupCache(maxAgeDays = 30) {
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const threshold = Date.now() - maxAgeMs;
    const thumbs = await this._readObject(KEY_THUMBNAILS);

    const next = { ...thumbs };
    const deletions = Object.values(thumbs || {}).filter((item) => Number(item?.timestamp || 0) < threshold);

    for (const item of deletions) {
      if (item?.path) {
        const info = await FileSystem.getInfoAsync(item.path);
        if (info.exists) {
          await FileSystem.deleteAsync(item.path, { idempotent: true });
        }
      }
      if (item?.mediaId) {
        delete next[String(item.mediaId)];
      }
    }

    await this._writeObject(KEY_THUMBNAILS, next);
    return deletions.length;
  }
}

const localStorageService = new LocalStorageService();

export {
  APP_MEDIA_ROOT,
  APP_MEDIA_IMAGES,
  APP_MEDIA_VIDEOS,
  APP_MEDIA_DOCUMENTS,
  APP_MEDIA_THUMBNAILS,
};

export default localStorageService;
