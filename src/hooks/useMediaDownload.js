import { useCallback, useEffect, useMemo, useState } from 'react';
import localStorageService from '../services/LocalStorageService';
import downloadQueue from '../services/DownloadQueue';

export default function useMediaDownload(mediaId) {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [localPath, setLocalPath] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!mediaId) return undefined;

    let mounted = true;

    const bootstrap = async () => {
      const record = await localStorageService.getMediaFile(mediaId);
      if (mounted && record?.localPath) {
        setLocalPath(record.localPath);
        setStatus('completed');
        setProgress(100);
        return;
      }
      // RE-ATTACH, don't assume idle: downloads are owned by the module-level
      // DownloadQueue/MediaService and keep running across navigation — the
      // queue row's status/progress are persisted on every progress tick, so
      // a remounted tile shows the live ring at its real percent. Paused stays
      // paused (never auto-resumed); only explicit pause/cancel stop bytes.
      const queueItem = await localStorageService.getDownloadQueueItem(mediaId);
      if (!mounted || !queueItem) return;
      const rowStatus = String(queueItem?.status || '');
      if (rowStatus === 'paused') {
        setStatus('paused');
        setProgress(Number(queueItem?.progress || 0));
      } else if (rowStatus === 'downloading') {
        setStatus('downloading');
        setProgress(Number(queueItem?.progress || 0));
      } else if (rowStatus === 'pending') {
        setStatus('queued');
        setProgress(Number(queueItem?.progress || 0));
      } else if (rowStatus === 'failed') {
        setStatus('failed');
        setProgress(0);
      }
    };

    bootstrap().catch(() => {});

    const unsubscribe = downloadQueue.subscribe((event) => {
      if (String(event?.mediaId) !== String(mediaId)) return;

      if (event.type === 'queued') {
        setStatus('queued');
      }
      if (event.type === 'start') {
        setStatus('downloading');
      }
      if (event.type === 'progress') {
        setStatus('downloading');
        setProgress(Number(event.progress || 0));
      }
      if (event.type === 'complete') {
        setStatus('completed');
        setProgress(100);
        setLocalPath(event.localPath || null);
      }
      if (event.type === 'failed') {
        setStatus('failed');
        setError(event.error || 'download failed');
      }
      if (event.type === 'paused') {
        setStatus('paused');
      }
      if (event.type === 'cancelled') {
        setStatus('cancelled');
        setProgress(0);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [mediaId]);

  const requestDownload = useCallback(async ({ chatId, messageType, filename, mediaUrl, messageId, groupId } = {}) => {
    if (!mediaId) return;
    setError(null);
    await downloadQueue.add({ mediaId, chatId, messageType, filename, mediaUrl, messageId, groupId });
  }, [mediaId]);

  const cancelDownload = useCallback(() => {
    if (!mediaId) return;
    downloadQueue.cancel(mediaId);
  }, [mediaId]);

  const pauseDownload = useCallback(() => {
    if (!mediaId) return;
    downloadQueue.pause(mediaId).catch(() => {});
  }, [mediaId]);

  // Resume needs the same descriptor as requestDownload — the byte-level
  // resume point itself is persisted inside MediaService.
  const resumeDownload = useCallback(async ({ chatId, messageType, filename, mediaUrl, messageId, groupId } = {}) => {
    if (!mediaId) return;
    setError(null);
    await downloadQueue.resume({ mediaId, chatId, messageType, filename, mediaUrl, messageId, groupId });
  }, [mediaId]);

  return useMemo(() => ({
    status,
    progress,
    localPath,
    error,
    isDownloaded: Boolean(localPath),
    isPaused: status === 'paused',
    requestDownload,
    cancelDownload,
    pauseDownload,
    resumeDownload,
  }), [status, progress, localPath, error, requestDownload, cancelDownload, pauseDownload, resumeDownload]);
}