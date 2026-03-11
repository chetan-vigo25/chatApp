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
      if (event.type === 'cancelled') {
        setStatus('cancelled');
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [mediaId]);

  const requestDownload = useCallback(async ({ chatId, messageType, filename }) => {
    if (!mediaId) return;
    setError(null);
    await downloadQueue.add({ mediaId, chatId, messageType, filename });
  }, [mediaId]);

  const cancelDownload = useCallback(() => {
    if (!mediaId) return;
    downloadQueue.cancel(mediaId);
  }, [mediaId]);

  return useMemo(() => ({
    status,
    progress,
    localPath,
    error,
    isDownloaded: Boolean(localPath),
    requestDownload,
    cancelDownload,
  }), [status, progress, localPath, error, requestDownload, cancelDownload]);
}