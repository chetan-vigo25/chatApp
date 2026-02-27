import { useCallback, useMemo, useState } from 'react';
import localStorageService from '../services/LocalStorageService';
import mediaService from '../services/MediaService';
import { compressMedia, getMessageTypeFromMime, validateMediaFile } from '../utils/mediaCompressor';
import { generateThumbnail } from '../utils/thumbnailGenerator';

export default function useMediaUpload() {
  const [uploads, setUploads] = useState({});

  const setUploadState = useCallback((uploadId, patch) => {
    setUploads((prev) => ({
      ...prev,
      [uploadId]: {
        ...(prev[uploadId] || {}),
        ...patch,
      },
    }));
  }, []);

  const uploadMedia = useCallback(async ({ file, chatId, messageType: forcedType, metadata = {} }) => {
    const validation = validateMediaFile(file || {});
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    const messageType = forcedType || validation.messageType || getMessageTypeFromMime(file?.type);
    const uploadId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    setUploadState(uploadId, {
      status: 'compressing',
      progress: 0,
      fileName: file?.name,
      messageType,
      chatId,
    });

    console.log('[MEDIA:UPLOAD:START]', {
      uploadId,
      name: file?.name,
      size: file?.size,
      messageType,
      chatId,
    });

    const processedFile = await compressMedia(file, messageType);
    const thumbnailUri = await generateThumbnail({ file: processedFile, messageType });

    if (thumbnailUri) {
      await localStorageService.saveThumbnail(uploadId, thumbnailUri).catch(() => {});
    }

    await localStorageService.queuePendingUpload(uploadId, {
      file,
      processedFile,
      messageType,
      chatId,
      metadata,
      thumbnailUri,
    });

    setUploadState(uploadId, { status: 'uploading', progress: 1, thumbnailUri });

    try {
      const response = await mediaService.uploadMedia({
        file: processedFile,
        chatId,
        messageType,
        onProgress: (progress) => {
          setUploadState(uploadId, { status: 'uploading', progress });
        },
      });

      const serverData = response?.data || {};
      // Always use _id.$oid if present
      const mediaId = serverData?._id?.$oid ? String(serverData._id.$oid) : (serverData.mediaId || serverData.id || uploadId);

      await mediaService.persistMediaRecord({
        mediaId,
        chatId,
        localPath: processedFile?.uri,
        previewUrl: serverData.previewUrl,
        thumbnailUrl: serverData.thumbnailUrl || thumbnailUri,
        messageType,
        metadata: {
          ...metadata,
          size: serverData.sizeAfter || file?.size,
          width: serverData.width,
          height: serverData.height,
          duration: serverData.duration,
        },
        _id: serverData._id,
      });

      await localStorageService.removePendingUpload(uploadId);
      setUploadState(uploadId, {
        status: 'completed',
        progress: 100,
        mediaId,
        serverData,
      });

      console.log('[MEDIA:UPLOAD:COMPLETE]', serverData);

      return {
        uploadId,
        mediaId,
        response,
        localUri: processedFile?.uri,
        thumbnailUri,
      };
    } catch (error) {
      await localStorageService.updatePendingUpload(uploadId, {
        status: 'failed',
        error: error?.message || 'upload failed',
      });

      setUploadState(uploadId, {
        status: 'failed',
        error: error?.message || 'upload failed',
      });

      throw error;
    }
  }, [setUploadState]);

  const retryUpload = useCallback(async (uploadId) => {
    const pending = await localStorageService.getPendingUploads();
    const item = pending.find((entry) => String(entry.uploadId) === String(uploadId));
    if (!item) throw new Error('Pending upload not found');

    await localStorageService.updatePendingUpload(uploadId, {
      status: 'pending',
      retries: Number(item?.retries || 0) + 1,
    });

    return uploadMedia({
      file: item.file,
      chatId: item.chatId,
      messageType: item.messageType,
      metadata: item.metadata,
    });
  }, [uploadMedia]);

  return useMemo(() => ({
    uploads,
    uploadMedia,
    retryUpload,
  }), [uploads, uploadMedia, retryUpload]);
}
