import mediaService from './MediaService';
import localStorageService from './LocalStorageService';

const MAX_CONCURRENT = 3;
const MAX_RETRIES = 2;

class DownloadQueue {
  queue = [];
  running = new Map();
  listeners = new Set();

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (_) {}
    }
  }

  async add(item) {
    if (!item?.mediaId) return;
    const mediaId = String(item.mediaId);

    const alreadyQueued = this.queue.some((entry) => String(entry?.mediaId) === mediaId);
    const running = this.running.has(mediaId);
    const queueItem = await localStorageService.getDownloadQueueItem(mediaId);
    const completed = queueItem?.status === 'completed';

    if (alreadyQueued || running || completed) {
      return;
    }

    await localStorageService.queueDownload(mediaId, {
      chatId: item.chatId,
      messageType: item.messageType,
      filename: item.filename,
    });

    this.queue.push({ ...item, mediaId });
    this._emit({ type: 'queued', mediaId });
    this._drain();
  }

  async hydratePending() {
    const pending = await localStorageService.getPendingDownloads();
    const normalized = pending.map((item) => ({
      mediaId: String(item.mediaId),
      chatId: item.chatId,
      messageType: item.messageType,
      filename: item.filename,
      retries: Number(item.retries || 0),
    }));

    for (const item of normalized) {
      if (!this.queue.some((entry) => String(entry.mediaId) === String(item.mediaId)) && !this.running.has(String(item.mediaId))) {
        this.queue.push(item);
      }
    }
    this._drain();
  }

  _drain() {
    while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
      const next = this.queue.shift();
      this._run(next);
    }
  }

  async _run(item) {
    const mediaId = String(item.mediaId);
    this.running.set(mediaId, true);
    this._emit({ type: 'start', mediaId });

    try {
      const localPath = await mediaService.downloadToLocal({
        mediaId,
        chatId: item.chatId,
        messageType: item.messageType,
        filename: item.filename,
        onProgress: async (progress) => {
          this._emit({ type: 'progress', mediaId, progress });
          await localStorageService.updateDownloadQueue(mediaId, { progress, status: 'downloading' });
        },
      });

      await localStorageService.upsertMediaFile({
        mediaId,
        chatId: item.chatId,
        localPath,
        messageType: item.messageType,
      });

      await localStorageService.updateDownloadQueue(mediaId, { status: 'completed', progress: 100, localPath });
      this._emit({ type: 'complete', mediaId, localPath });
    } catch (error) {
      const current = await localStorageService.getDownloadQueueItem(mediaId);
      const retries = Number(current?.retries || item?.retries || 0);

      if (retries < MAX_RETRIES) {
        await localStorageService.updateDownloadQueue(mediaId, {
          status: 'failed',
          retries: retries + 1,
          error: error?.message || 'download failed',
        });
        this.queue.push({ ...item, retries: retries + 1 });
      } else {
        await localStorageService.updateDownloadQueue(mediaId, {
          status: 'failed',
          retries,
          error: error?.message || 'download failed',
        });
      }

      this._emit({ type: 'failed', mediaId, error: error?.message || 'download failed' });
    } finally {
      this.running.delete(mediaId);
      this._drain();
    }
  }

  cancel(mediaId) {
    const key = String(mediaId);
    this.queue = this.queue.filter((item) => String(item.mediaId) !== key);
    mediaService.cancelDownload(key);
    this.running.delete(key);
    localStorageService.updateDownloadQueue(key, { status: 'cancelled' }).catch(() => {});
    this._emit({ type: 'cancelled', mediaId: key });
    this._drain();
  }
}

export default new DownloadQueue();
