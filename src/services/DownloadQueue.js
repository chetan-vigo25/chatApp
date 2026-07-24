import mediaService, { isDownloadPausedError, isDownloadCancelledError } from './MediaService';
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
    // User-paused items stay paused — only an explicit resume() re-adds them
    // (auto-download / boot hydration must never silently restart them).
    const paused = queueItem?.status === 'paused';

    if (alreadyQueued || running || completed || (paused && !item.resume)) {
      return;
    }

    await localStorageService.queueDownload(mediaId, {
      chatId: item.chatId,
      messageType: item.messageType,
      filename: item.filename,
      mediaUrl: item.mediaUrl || null,
      messageId: item.messageId || null,
      groupId: item.groupId || null,
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
      mediaUrl: item.mediaUrl || null,
      messageId: item.messageId || null,
      groupId: item.groupId || null,
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
        mediaUrl: item.mediaUrl || null,
        messageId: item.messageId || null,
        groupId: item.groupId || null,
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
      // Intentional pause/cancel — the queue row is already in its terminal
      // 'paused'/'cancelled' state (MediaService wrote it); never retry.
      if (isDownloadPausedError(error)) {
        this._emit({ type: 'paused', mediaId });
        return; // finally still runs (running cleanup + drain)
      }
      if (isDownloadCancelledError(error)) {
        this._emit({ type: 'cancelled', mediaId });
        return;
      }

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

  // Pause a queued or in-flight download. In-flight tasks persist resumeData
  // (MediaService) so resume() continues from the partial bytes.
  async pause(mediaId) {
    const key = String(mediaId);
    const wasQueued = this.queue.some((item) => String(item.mediaId) === key);
    this.queue = this.queue.filter((item) => String(item.mediaId) !== key);

    if (this.running.has(key)) {
      await mediaService.pauseDownload(key).catch(() => {});
      // _run's catch emits 'paused' when the task settles.
    } else if (wasQueued) {
      await localStorageService.updateDownloadQueue(key, { status: 'paused' }).catch(() => {});
      this._emit({ type: 'paused', mediaId: key });
    }
    this._drain();
  }

  // Resume a paused item — re-enqueue it; downloadToLocal picks up the
  // persisted pause snapshot and resumeAsync()s from the saved offset.
  async resume(item) {
    if (!item?.mediaId) return;
    await this.add({ ...item, resume: true });
  }

  cancel(mediaId) {
    const key = String(mediaId);
    this.queue = this.queue.filter((item) => String(item.mediaId) !== key);
    // Deletes partial bytes + paused snapshot and marks the row 'cancelled'.
    Promise.resolve(mediaService.cancelDownload(key)).catch(() => {});
    this._emit({ type: 'cancelled', mediaId: key });
    this._drain();
  }
}

export default new DownloadQueue();
