import { kv } from './kvStorage';
import * as FileSystem from 'expo-file-system/legacy';
import { createKeyedSerial } from '../utils/keyedSerial';
import { candidateMediaPaths } from '../utils/mediaLocalPaths';

const KEY_PREFIX = 'media_v2';
const KEY_MEDIA_FILES = `${KEY_PREFIX}:media_files`;
const KEY_THUMBNAILS = `${KEY_PREFIX}:thumbnails_cache`;
const KEY_DOWNLOAD_QUEUE = `${KEY_PREFIX}:download_queue`;
const KEY_PENDING_UPLOADS = `${KEY_PREFIX}:pending_uploads`;

// Presigned S3 URLs live 1h — treat a cached http(s) thumbnail URL older than
// this as expired (read-side miss → callers re-resolve a fresh one).
const THUMB_URL_TTL_MS = 50 * 60 * 1000;

// WhatsApp-style folder structure:
//   WhatsApp/Media/WhatsApp Images/
//   WhatsApp/Media/WhatsApp Video/
//   WhatsApp/Media/WhatsApp Documents/
// Our equivalent:
//   TalksTry/Media/TalksTry Images/
//   TalksTry/Media/TalksTry Video/
//   TalksTry/Media/TalksTry Documents/
//   TalksTry/Media/TalksTry Audio/
const APP_NAME = 'TalksTry';
const APP_MEDIA_ROOT = `${FileSystem.documentDirectory}${APP_NAME}/Media/`;
const APP_MEDIA_IMAGES = `${APP_MEDIA_ROOT}${APP_NAME} Images/`;
const APP_MEDIA_VIDEOS = `${APP_MEDIA_ROOT}${APP_NAME} Video/`;
const APP_MEDIA_AUDIO = `${APP_MEDIA_ROOT}${APP_NAME} Audio/`;
const APP_MEDIA_DOCUMENTS = `${APP_MEDIA_ROOT}${APP_NAME} Documents/`;
const APP_MEDIA_THUMBNAILS = `${APP_MEDIA_ROOT}.Thumbnails/`;

// Every read-modify-write of one of the media maps runs strictly one after another.
// upsertMediaFile used to read the whole `media_files` JSON, await an md5 of the file,
// then write the stale map back — three album tiles finishing together erased each other's
// records (and a progress tick could overwrite a `completed` queue row with `downloading`).
const serial = createKeyedSerial();

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
  async _getFileFingerprint(filePath) {
    if (!filePath) return null;
    try {
      const info = await FileSystem.getInfoAsync(filePath, { md5: true });
      if (!info?.exists) return null;
      const md5 = info?.md5 || 'nomd5';
      const size = Number(info?.size || 0);
      return `${md5}:${size}`;
    } catch {
      return null;
    }
  }

    /**
     * Hydrate downloaded media from persistent storage, verify file existence, remove stale DB entries.
     * Returns a map of valid downloaded media { mediaId: localPath }
     */
    async hydrateDownloadedMedia() {
      await this.init();
      return serial(KEY_MEDIA_FILES, async () => {
        const mediaMap = await this._readObject(KEY_MEDIA_FILES);
        const validMedia = {};
        let changed = false;
        for (const [mediaId, record] of Object.entries(mediaMap)) {
          if (record?.localPath) {
            // A stored absolute path can point at a PREVIOUS app container (iOS update /
            // reinstall / restore) while the file is fine under the current one — re-base
            // before concluding the file is gone.
            const live = await this.resolveExistingPath(record.localPath);
            if (live) {
              if (live !== record.localPath) {
                mediaMap[mediaId] = { ...record, localPath: live };
                changed = true;
              }
              validMedia[mediaId] = live;
            } else {
              // Remove stale entry
              delete mediaMap[mediaId];
              changed = true;
            }
          }
        }
        if (changed) {
          await this._writeObject(KEY_MEDIA_FILES, mediaMap);
        }
        return validMedia;
      });
    }

  _initialized = false;

  async init() {
    if (this._initialized) return;

    await ensureDir(APP_MEDIA_ROOT);
    await ensureDir(APP_MEDIA_IMAGES);
    await ensureDir(APP_MEDIA_VIDEOS);
    await ensureDir(APP_MEDIA_AUDIO);
    await ensureDir(APP_MEDIA_DOCUMENTS);
    await ensureDir(APP_MEDIA_THUMBNAILS);

    const [mediaRaw, thumbRaw, queueRaw, pendingRaw] = await Promise.all([
      kv.getItem(KEY_MEDIA_FILES),
      kv.getItem(KEY_THUMBNAILS),
      kv.getItem(KEY_DOWNLOAD_QUEUE),
      kv.getItem(KEY_PENDING_UPLOADS),
    ]);

    if (!mediaRaw) await kv.setItem(KEY_MEDIA_FILES, JSON.stringify({}));
    if (!thumbRaw) await kv.setItem(KEY_THUMBNAILS, JSON.stringify({}));
    if (!queueRaw) await kv.setItem(KEY_DOWNLOAD_QUEUE, JSON.stringify({}));
    if (!pendingRaw) await kv.setItem(KEY_PENDING_UPLOADS, JSON.stringify({}));

    this._initialized = true;
  }

  async _readObject(key) {
    await this.init();
    const raw = await kv.getItem(key);
    return safeJsonParse(raw, {});
  }

  async _writeObject(key, value) {
    await this.init();
    await kv.setItem(key, JSON.stringify(value || {}));
  }

  async getMediaRootByType(messageType) {
    const type = (messageType || '').toLowerCase();
    if (type === 'image' || type === 'photo') return APP_MEDIA_IMAGES;
    if (type === 'video') return APP_MEDIA_VIDEOS;
    if (type === 'audio' || type === 'voice' || type === 'ptt') return APP_MEDIA_AUDIO;
    return APP_MEDIA_DOCUMENTS;
  }

  async buildMediaPath({ mediaId, chatId, filename, messageType }) {
    const root = await this.getMediaRootByType(messageType);
    const chatDir = `${root}${chatId || 'general'}/`;
    await ensureDir(chatDir);

    // Strip only what breaks a filesystem path (separators / reserved chars) —
    // the original filename otherwise lands on disk as-is, so shares/saves
    // carry the real name.
    const base = String(filename || `${mediaId || Date.now()}`)
      .replace(/[/\\:*?"<>|]/g, '_')
      .trim() || `${mediaId || Date.now()}`;
    // Per-media SUBFOLDER, not a bare `${chatDir}${base}`: two attachments of
    // one album routinely share a filename (`image.jpg`, `IMG_0001.jpg`), and
    // a flat path let the second download overwrite the first — every tile of
    // the album then opened the SAME photo. The file itself keeps the original
    // name inside its folder, so saves/shares still carry the real filename.
    if (mediaId) {
      const mediaDir = `${chatDir}${String(mediaId).replace(/[^A-Za-z0-9_-]/g, '')}/`;
      await ensureDir(mediaDir);
      return `${mediaDir}${base}`;
    }
    return `${chatDir}${base}`;
  }

  async upsertMediaFile(record) {
    const key = String(record?.id || record?.mediaId || record?.serverMessageId || Date.now());

    // The md5 of a whole file can take a while: compute it BEFORE entering the serialized
    // read-modify-write so progress ticks and other tiles are not queued behind it.
    const incomingFingerprint = record?.localPath
      ? await this._getFileFingerprint(record.localPath)
      : null;

    return serial(KEY_MEDIA_FILES, async () => {
      const mediaMap = await this._readObject(KEY_MEDIA_FILES);

      if (incomingFingerprint) {
        for (const [existingKey, existingRecord] of Object.entries(mediaMap)) {
          if (existingKey === key) continue;
          const existingFingerprint = existingRecord?.fingerprint || null;
          if (existingFingerprint && existingFingerprint === incomingFingerprint) {
            mediaMap[key] = {
              ...(mediaMap[key] || {}),
              ...existingRecord,
              ...record,
              localPath: existingRecord.localPath,
              fingerprint: incomingFingerprint,
              mediaId: key,
              updatedAt: Date.now(),
            };
            await this._writeObject(KEY_MEDIA_FILES, mediaMap);
            return mediaMap[key];
          }
        }
      }

      mediaMap[key] = {
        ...(mediaMap[key] || {}),
        ...record,
        fingerprint: incomingFingerprint || mediaMap[key]?.fingerprint || null,
        mediaId: key,
        updatedAt: Date.now(),
      };

      await this._writeObject(KEY_MEDIA_FILES, mediaMap);
      return mediaMap[key];
    });
  }

  async resolveExistingPath(path) {
    for (const candidate of candidateMediaPaths(path, FileSystem.documentDirectory)) {
      try {
        const info = await FileSystem.getInfoAsync(candidate);
        if (info?.exists) return candidate;
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  /** Point an existing record at a new location (re-based path). Never creates a record. */
  async repointMediaRecord(mediaId, localPath) {
    if (!mediaId || !localPath) return;
    const key = String(mediaId);
    await serial(KEY_MEDIA_FILES, async () => {
      const mediaMap = await this._readObject(KEY_MEDIA_FILES);
      if (!mediaMap[key]) return;
      mediaMap[key] = { ...mediaMap[key], localPath, updatedAt: Date.now() };
      await this._writeObject(KEY_MEDIA_FILES, mediaMap);
    });
  }

  /** Drop the RECORD of a media whose file is gone (never touches files): the bubble offers a download again. */
  async forgetMediaRecord(mediaId) {
    if (!mediaId) return;
    const key = String(mediaId);
    await serial(KEY_MEDIA_FILES, async () => {
      const mediaMap = await this._readObject(KEY_MEDIA_FILES);
      if (!mediaMap[key]) return;
      delete mediaMap[key];
      await this._writeObject(KEY_MEDIA_FILES, mediaMap);
    });
  }

  async getMediaFile(mediaId) {
    if (!mediaId) return null;
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    return mediaMap[String(mediaId)] || null;
  }

  async getMediaCache(mediaId) {
    if (!mediaId) return null;
    const record = await this.getMediaFile(mediaId);
    if (!record) return null;

    return {
      mediaId: String(mediaId),
      localPath: record?.localPath || null,
      downloadStatus:
        String(record?.downloadStatus || '').toUpperCase() ||
        (record?.localPath ? 'DOWNLOADED' : 'NOT_DOWNLOADED'),
      downloadedAt: record?.downloadedAt || null,
      updatedAt: record?.updatedAt || null,
      lastError: record?.lastError || null,
    };
  }

  async getAllMediaCache() {
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const output = {};

    Object.entries(mediaMap || {}).forEach(([mediaId, record]) => {
      output[String(mediaId)] = {
        mediaId: String(mediaId),
        localPath: record?.localPath || null,
        downloadStatus:
          String(record?.downloadStatus || '').toUpperCase() ||
          (record?.localPath ? 'DOWNLOADED' : 'NOT_DOWNLOADED'),
        downloadedAt: record?.downloadedAt || null,
        updatedAt: record?.updatedAt || null,
        lastError: record?.lastError || null,
      };
    });

    return output;
  }

  async removeDownloadedMedia(mediaId) {
    return this.removeMediaFile(mediaId);
  }

  async getStorageUsage() {
    await this.init();
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const thumbnails = await this._readObject(KEY_THUMBNAILS);

    let totalBytes = 0;
    let mediaBytes = 0;
    let thumbnailBytes = 0;
    let fileCount = 0;

    for (const item of Object.values(mediaMap || {})) {
      if (!item?.localPath) continue;
      try {
        const info = await FileSystem.getInfoAsync(item.localPath);
        if (!info?.exists) continue;
        const size = Number(info?.size || 0);
        totalBytes += size;
        mediaBytes += size;
        fileCount += 1;
      } catch {}
    }

    for (const item of Object.values(thumbnails || {})) {
      if (!item?.path) continue;
      try {
        const info = await FileSystem.getInfoAsync(item.path);
        if (!info?.exists) continue;
        const size = Number(info?.size || 0);
        totalBytes += size;
        thumbnailBytes += size;
      } catch {}
    }

    return {
      totalBytes,
      mediaBytes,
      thumbnailBytes,
      fileCount,
      totalMB: Number((totalBytes / 1024 / 1024).toFixed(2)),
    };
  }

  async cleanupOrphanedMedia() {
    await this.init();
    return serial(KEY_MEDIA_FILES, () => serial(KEY_DOWNLOAD_QUEUE, async () => {
      const mediaMap = await this._readObject(KEY_MEDIA_FILES);
      const thumbnailMap = await this._readObject(KEY_THUMBNAILS);
      const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);

      let removed = 0;

      for (const [mediaId, record] of Object.entries(mediaMap)) {
        const localPath = record?.localPath;
        if (!localPath) continue;
        // Re-base first: a stale iOS container path must not erase the record of a file
        // that is still on disk under the current container.
        const live = await this.resolveExistingPath(localPath);
        if (live) {
          if (live !== localPath) mediaMap[mediaId] = { ...record, localPath: live };
        } else {
          delete mediaMap[mediaId];
          delete queueMap[mediaId];
          removed += 1;
        }
      }

      for (const [mediaId, thumb] of Object.entries(thumbnailMap)) {
        const thumbPath = thumb?.path;
        if (!thumbPath) {
          delete thumbnailMap[mediaId];
          continue;
        }
        try {
          const info = await FileSystem.getInfoAsync(thumbPath);
          if (!info?.exists) {
            delete thumbnailMap[mediaId];
            removed += 1;
          }
        } catch {
          delete thumbnailMap[mediaId];
          removed += 1;
        }
      }

      await Promise.all([
        this._writeObject(KEY_MEDIA_FILES, mediaMap),
        this._writeObject(KEY_THUMBNAILS, thumbnailMap),
        this._writeObject(KEY_DOWNLOAD_QUEUE, queueMap),
      ]);

      return removed;
    }));
  }

  async clearCache({ clearThumbnails = true, clearFailedQueue = true } = {}) {
    await this.init();
    let removed = 0;

    if (clearThumbnails) {
      const thumbnails = await this._readObject(KEY_THUMBNAILS);
      for (const item of Object.values(thumbnails || {})) {
        if (!item?.path) continue;
        try {
          const info = await FileSystem.getInfoAsync(item.path);
          if (info?.exists) {
            await FileSystem.deleteAsync(item.path, { idempotent: true });
            removed += 1;
          }
        } catch {}
      }
      await this._writeObject(KEY_THUMBNAILS, {});
    }

    if (clearFailedQueue) {
      const queue = await this._readObject(KEY_DOWNLOAD_QUEUE);
      const next = {};
      Object.entries(queue || {}).forEach(([k, v]) => {
        if (!['failed', 'cancelled'].includes(v?.status)) {
          next[k] = v;
        }
      });
      await this._writeObject(KEY_DOWNLOAD_QUEUE, next);
    }

    return removed;
  }

  async enforceStorageQuota(maxBytes = 1024 * 1024 * 1024) {
    await this.init();
    return serial(KEY_MEDIA_FILES, async () => {
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const records = Object.entries(mediaMap || []).map(([mediaId, record]) => ({
      mediaId,
      ...record,
      ts: Number(record?.updatedAt || record?.createdAtTs || 0),
    }));

    const withSize = [];
    let total = 0;
    for (const record of records) {
      if (!record?.localPath) continue;
      try {
        const info = await FileSystem.getInfoAsync(record.localPath);
        if (!info?.exists) continue;
        const size = Number(info?.size || 0);
        total += size;
        withSize.push({ ...record, size });
      } catch {}
    }

    if (total <= maxBytes) {
      return { evicted: 0, totalBytes: total };
    }

    const sortedOldest = withSize.sort((a, b) => a.ts - b.ts);
    let evicted = 0;

    for (const item of sortedOldest) {
      if (total <= maxBytes) break;
      try {
        await FileSystem.deleteAsync(item.localPath, { idempotent: true });
      } catch {}
      delete mediaMap[String(item.mediaId)];
      total -= Number(item.size || 0);
      evicted += 1;
    }

    await this._writeObject(KEY_MEDIA_FILES, mediaMap);
    return { evicted, totalBytes: total };
    });
  }

  async getMediaFilesByChat(chatId) {
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const all = Object.values(mediaMap || {});
    return all
      .filter((item) => !chatId || String(item?.chatId) === String(chatId))
      .sort((a, b) => Number(b?.createdAtTs || b?.updatedAt || 0) - Number(a?.createdAtTs || a?.updatedAt || 0));
  }

  async clearMediaByChatId(chatId) {
    if (!chatId) return 0;
    const normalized = String(chatId);
    const mediaMap = await this._readObject(KEY_MEDIA_FILES);
    const mediaItems = Object.entries(mediaMap || {}).filter(([, item]) => String(item?.chatId || '') === normalized);

    if (mediaItems.length === 0) return 0;

    await Promise.all(mediaItems.map(async ([mediaId]) => {
      await this.removeMediaFile(mediaId);
    }));

    return mediaItems.length;
  }

  async removeMediaFile(mediaId) {
    if (!mediaId) return;
    const key = String(mediaId);
    return serial(KEY_MEDIA_FILES, () => serial(KEY_DOWNLOAD_QUEUE, async () => {
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
    }));
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
    return hit?.path || hit?.url || null;
  }

  async saveThumbnailReference(mediaId, thumbnailUrl, mediaType = 'image') {
    if (!mediaId || !thumbnailUrl) return null;
    const key = String(mediaId);
    const thumbnailMap = await this._readObject(KEY_THUMBNAILS);
    thumbnailMap[key] = {
      ...(thumbnailMap[key] || {}),
      mediaId: key,
      url: String(thumbnailUrl),
      mediaType: String(mediaType || 'image'),
      timestamp: Date.now(),
    };
    await this._writeObject(KEY_THUMBNAILS, thumbnailMap);
    return thumbnailMap[key];
  }

  async getThumbnailReference(mediaId) {
    if (!mediaId) return null;
    const key = String(mediaId);
    const thumbnailMap = await this._readObject(KEY_THUMBNAILS);
    const hit = thumbnailMap[key] || null;
    if (!hit) return null;
    let thumbnailUrl = hit?.url || hit?.path || null;
    // A cached presigned http(s) URL past its TTL is almost certainly expired
    // (S3 403) — treat it as a cache miss so callers hit the resolve path.
    // Local file:// / non-http refs keep working regardless of age.
    if (
      thumbnailUrl &&
      /^https?:\/\//i.test(thumbnailUrl) &&
      Date.now() - Number(hit?.timestamp || 0) > THUMB_URL_TTL_MS
    ) {
      const localPath = hit?.path && !/^https?:\/\//i.test(hit.path) ? hit.path : null;
      if (localPath) {
        thumbnailUrl = localPath; // keep serving the on-device copy
      } else {
        delete thumbnailMap[key];
        await this._writeObject(KEY_THUMBNAILS, thumbnailMap);
        return null;
      }
    }
    return {
      mediaId: key,
      thumbnailUrl,
      mediaType: hit?.mediaType || null,
      timestamp: Number(hit?.timestamp || 0),
    };
  }

  async queueDownload(mediaId, payload = {}) {
    if (!mediaId) return;
    await serial(KEY_DOWNLOAD_QUEUE, async () => {
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
    });
  }

  async updateDownloadQueue(mediaId, patch = {}) {
    if (!mediaId) return;
    const key = String(mediaId);
    await serial(KEY_DOWNLOAD_QUEUE, async () => {
      const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
      queueMap[key] = {
        ...(queueMap[key] || { mediaId: key }),
        ...patch,
        updatedAt: Date.now(),
      };
      await this._writeObject(KEY_DOWNLOAD_QUEUE, queueMap);
    });
  }

  async getDownloadQueueItem(mediaId) {
    if (!mediaId) return null;
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    return queueMap[String(mediaId)] || null;
  }

  async getPendingDownloads() {
    // NOTE: 'paused' rows are intentionally excluded — boot-time hydration must
    // NOT auto-resume a download the user explicitly paused. They surface via
    // getPausedDownloads() and resume only on user tap.
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    return Object.values(queueMap || {})
      .filter((item) => ['pending', 'downloading', 'failed'].includes(item?.status))
      .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
  }

  async getPausedDownloads() {
    const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
    return Object.values(queueMap || {})
      .filter((item) => item?.status === 'paused')
      .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
  }

  async removeFromDownloadQueue(mediaId) {
    if (!mediaId) return;
    await serial(KEY_DOWNLOAD_QUEUE, async () => {
      const queueMap = await this._readObject(KEY_DOWNLOAD_QUEUE);
      delete queueMap[String(mediaId)];
      await this._writeObject(KEY_DOWNLOAD_QUEUE, queueMap);
    });
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
  APP_MEDIA_AUDIO,
  APP_MEDIA_DOCUMENTS,
  APP_MEDIA_THUMBNAILS,
};

export default localStorageService;