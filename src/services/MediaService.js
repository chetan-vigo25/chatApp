import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { BACKEND_URL } from '@env';
import { apiCall } from '../Config/Https';
import localStorageService from './LocalStorageService';

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

class MediaService {
  activeUploads = new Map();
  activeDownloads = new Map();

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

  async getDownloadUrl(mediaId) {
    return apiCall('POST', `${API_PREFIX}/download`, { mediaId });
  }

  async downloadToLocal({ mediaId, chatId, messageType, filename, onProgress, force = false }) {
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
    const signed = await this.getDownloadUrl(mediaId);
    const downloadUrl = signed?.data?.downloadUrl || signed?.downloadUrl || null;
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

    await localStorageService.queueDownload(mediaId, {
      chatId,
      messageType,
      filename: safeName,
    });
    await localStorageService.updateDownloadQueue(mediaId, { status: 'downloading', progress: 0 });

    const task = FileSystem.createDownloadResumable(
      downloadUrl,
      destination,
      {},
      (event) => {
        const total = Number(event?.totalBytesExpectedToWrite || 0);
        const written = Number(event?.totalBytesWritten || 0);
        const progress = total > 0 ? (written / total) * 100 : 0;
        if (typeof onProgress === 'function') onProgress(progress);
        localStorageService.updateDownloadQueue(mediaId, { status: 'downloading', progress }).catch(() => {});
      }
    );

    this.activeDownloads.set(String(mediaId), task);
    console.log('[MEDIA:DOWNLOAD:START]', mediaId);

    const result = await task.downloadAsync();
    const localPath = result?.uri || destination;
    this.activeDownloads.delete(String(mediaId));

    await localStorageService.updateDownloadQueue(mediaId, {
      status: 'completed',
      progress: 100,
      localPath,
      completedAt: Date.now(),
    });

    console.log('[MEDIA:DOWNLOAD:COMPLETE]', { mediaId, localPath });
    return localPath;
  }

  cancelDownload(mediaId) {
    const task = this.activeDownloads.get(String(mediaId));
    if (task) {
      task.pauseAsync().catch(() => {});
      this.activeDownloads.delete(String(mediaId));
    }
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
      serverUrl: buildAbsoluteUrl(previewUrl),
      thumbnailUrl: buildAbsoluteUrl(thumbnailUrl),
      messageType,
      metadata: metadata || {},
      createdAtTs: Date.now(),
    };

    console.log('[MEDIA:LOCAL:SAVE]', payload);
    return localStorageService.upsertMediaFile(payload);
  }
}

export default new MediaService();
