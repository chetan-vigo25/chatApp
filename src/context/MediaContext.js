import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import NetInfo from '@react-native-community/netinfo';
import localStorageService from '../services/LocalStorageService';
import downloadQueue from '../services/DownloadQueue';
import mediaService from '../services/MediaService';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';

const MediaContext = createContext(null);

const initialState = {
  uploads: {},
  downloads: {},
  byMediaId: {},
  isOnline: true,
};

function reducer(state, action) {
  switch (action.type) {
    case 'NET':
      return { ...state, isOnline: Boolean(action.payload) };
    case 'UPLOAD': {
      const { id, patch } = action.payload;
      return {
        ...state,
        uploads: {
          ...state.uploads,
          [id]: { ...(state.uploads[id] || {}), ...patch },
        },
      };
    }
    case 'DOWNLOAD': {
      const { id, patch } = action.payload;
      return {
        ...state,
        downloads: {
          ...state.downloads,
          [id]: { ...(state.downloads[id] || {}), ...patch },
        },
      };
    }
    case 'MEDIA_UPSERT': {
      const { mediaId, data } = action.payload;
      // Always use _id.$oid if present
      const key = data?._id?.$oid ? String(data._id.$oid) : String(mediaId);
      return {
        ...state,
        byMediaId: {
          ...state.byMediaId,
          [key]: {
            ...(state.byMediaId[key] || {}),
            ...data,
            mediaId: key,
          },
        },
      };
    }
    case 'MEDIA_DELETE': {
      const key = String(action.payload);
      const next = { ...state.byMediaId };
      delete next[key];
      return { ...state, byMediaId: next };
    }
    default:
      return state;
  }
}

export function MediaProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const processPendingUploads = useCallback(async () => {
    const pending = await localStorageService.getPendingUploads();
    if (!pending?.length) return;

    for (const item of pending) {
      const uploadId = String(item.uploadId);
      try {
        dispatch({ type: 'UPLOAD', payload: { id: uploadId, patch: { status: 'uploading', progress: 1 } } });

        const response = await mediaService.uploadMedia({
          file: item.processedFile || item.file,
          chatId: item.chatId,
          messageType: item.messageType,
          onProgress: (progress) => {
            dispatch({ type: 'UPLOAD', payload: { id: uploadId, patch: { status: 'uploading', progress } } });
          },
        });

        const server = response?.data || {};
        const mediaId = String(server.mediaId || server.id || uploadId);

        await mediaService.persistMediaRecord({
          mediaId,
          chatId: item.chatId,
          localPath: item?.processedFile?.uri || item?.file?.uri || null,
          previewUrl: server.previewUrl,
          thumbnailUrl: server.thumbnailUrl || item.thumbnailUri,
          messageType: item.messageType,
          metadata: {
            size: server.sizeAfter,
            width: server.width,
            height: server.height,
            duration: server.duration,
          },
        });

        await localStorageService.removePendingUpload(uploadId);
        dispatch({ type: 'UPLOAD', payload: { id: uploadId, patch: { status: 'completed', progress: 100, mediaId } } });
      } catch (error) {
        await localStorageService.updatePendingUpload(uploadId, {
          status: 'failed',
          retries: Number(item?.retries || 0) + 1,
          error: error?.message || 'upload failed',
        });
        dispatch({ type: 'UPLOAD', payload: { id: uploadId, patch: { status: 'failed', error: error?.message || 'upload failed' } } });
      }
    }
  }, []);

  useEffect(() => {
    localStorageService.init().catch(() => {});
    downloadQueue.hydratePending().catch(() => {});
    processPendingUploads().catch(() => {});

    const unsubNet = NetInfo.addEventListener((net) => {
      const online = Boolean(net?.isConnected && net?.isInternetReachable !== false);
      dispatch({ type: 'NET', payload: online });
      if (online) {
        downloadQueue.hydratePending().catch(() => {});
        processPendingUploads().catch(() => {});
      }
    });

    const unsubQueue = downloadQueue.subscribe((event) => {
      const id = String(event?.mediaId || '');
      if (!id) return;
      if (event.type === 'progress') {
        dispatch({ type: 'DOWNLOAD', payload: { id, patch: { status: 'downloading', progress: event.progress } } });
      }
      if (event.type === 'start') {
        dispatch({ type: 'DOWNLOAD', payload: { id, patch: { status: 'downloading' } } });
      }
      if (event.type === 'queued') {
        dispatch({ type: 'DOWNLOAD', payload: { id, patch: { status: 'queued', progress: 0 } } });
      }
      if (event.type === 'complete') {
        dispatch({ type: 'DOWNLOAD', payload: { id, patch: { status: 'completed', progress: 100, localPath: event.localPath } } });
        dispatch({ type: 'MEDIA_UPSERT', payload: { mediaId: id, data: { localPath: event.localPath } } });
      }
      if (event.type === 'failed') {
        dispatch({ type: 'DOWNLOAD', payload: { id, patch: { status: 'failed', error: event.error } } });
      }
    });

    const socket = getSocket();
    const onMessageNew = (payload = {}) => {
      const source = payload?.data || payload;
      const mediaId = source?.mediaId || source?._id || source?.id;
      if (!mediaId) return;

      dispatch({
        type: 'MEDIA_UPSERT',
        payload: {
          mediaId: String(mediaId),
          data: {
            mediaId: String(mediaId),
            chatId: source?.chatId || source?.roomId,
            messageType: source?.messageType || source?.fileCategory,
            serverUrl: source?.mediaUrl || source?.url || source?.previewUrl,
            thumbnailUrl: source?.thumbnailUrl || source?.previewUrl,
          },
        },
      });
    };

    const onDeleteEveryone = async (payload = {}) => {
      const source = payload?.data || payload;
      const mediaId = source?.messageId || source?._id || source?.id;
      if (!mediaId) return;
      dispatch({ type: 'MEDIA_DELETE', payload: String(mediaId) });
    };

    if (socket && isSocketConnected()) {
      socket.on('message:new', onMessageNew);
      socket.on('message:delete:everyone', onDeleteEveryone);
      socket.on('message:delete:everyone:response', onDeleteEveryone);
    }

    return () => {
      unsubNet?.();
      unsubQueue?.();
      if (socket) {
        socket.off('message:new', onMessageNew);
        socket.off('message:delete:everyone', onDeleteEveryone);
        socket.off('message:delete:everyone:response', onDeleteEveryone);
      }
    };
  }, [processPendingUploads]);

  const requestDownload = useCallback(async (payload) => {
    await downloadQueue.add(payload);
  }, []);

  const deleteForMe = useCallback(async (mediaId) => {
    await localStorageService.removeMediaFile(mediaId);
    dispatch({ type: 'MEDIA_DELETE', payload: String(mediaId) });
  }, []);

  const deleteForEveryone = useCallback(async (mediaId) => {
    await mediaService.deleteMedia(mediaId);
    dispatch({ type: 'MEDIA_DELETE', payload: String(mediaId) });
  }, []);

  const value = useMemo(() => ({
    state,
    requestDownload,
    deleteForMe,
    deleteForEveryone,
  }), [state, requestDownload, deleteForMe, deleteForEveryone]);

  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}

export const useMediaContext = () => {
  const context = useContext(MediaContext);
  if (!context) {
    throw new Error('useMediaContext must be used inside MediaProvider');
  }
  return context;
};
