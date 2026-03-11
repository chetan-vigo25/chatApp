import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Keyboard, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from 'expo-file-system/legacy';
import moment from "moment";
import { useDispatch, useSelector } from "react-redux";
import { chatMessage, chatListData, mediaUpload } from "../Redux/Reducer/Chat/Chat.reducer";
import { getSocket, isSocketConnected, reconnectSocket } from "../Redux/Services/Socket/socket";
import { useNetwork } from "../contexts/NetworkContext";
import { useImage } from "../contexts/ImageProvider";
import { useFocusEffect } from "@react-navigation/native";
import { normalizePresencePayload, normalizeStatus, PRESENCE_STATUS } from "../utils/presence";
import { useRealtimeChat } from "./RealtimeChatContext";
import localStorageService from '../services/LocalStorageService';
import mediaDownloadManager, { MEDIA_DOWNLOAD_STATUS, resolveMediaIdentity } from '../services/MediaDownloadManager';
import { apiCall } from '../Config/Https';
import {
  clearChatLocalArtifacts,
  getChatClearedAt,
  getChatMessagesKey,
  removeMessagesByChatId,
} from '../utils/chatClearStorage';

import {
  normalizeUri,
  uploadMediaFile,
} from "../utils/mediaService";

/* Constants */
const MAX_LOCAL_SAVE = 300;
const MAX_RECONNECT_ATTEMPTS = 5;
const TYPING_TIMEOUT = 3000; // 3 seconds
const PRESENCE_HEARTBEAT_INTERVAL = 30000;
const PRESENCE_POLL_INTERVAL = 45000;
const PRESENCE_BACKGROUND_AWAY_DELAY = 30000;
const PRESENCE_IDLE_TIMEOUT = 5 * 60 * 1000;
const MANUAL_PRESENCE_QUEUE_KEY = "presence_manual_queue";
const MEDIA_STATUS_QUEUE_KEY = 'media_status_update_queue';
const DELETED_TOMBSTONES_PREFIX = "chat_deleted_tombstones_";
const READ_MARK_DELAY = 800;
const SOCKET_FETCH_LIMIT = 50;
const LOCAL_SAVE_DEBOUNCE_MS = 220;
const MEDIA_STATUS_ACK_TIMEOUT_MS = 9000;
const MEDIA_STATUS_MAX_RETRIES = 5;
const MEDIA_STATUS_BASE_RETRY_DELAY_MS = 2000;
const MEDIA_UPLOAD_QUEUE_KEY = 'media_upload_queue';
const MEDIA_UPLOAD_MAX_RETRIES = 4;
const MEDIA_UPLOAD_TIMEOUT_MS = 30000;

const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    // Prefer _id.$oid for MongoDB
    if (value._id && value._id.$oid) return String(value._id.$oid);
    const candidate = value._id || value.id || value.userId || value.$oid || null;
    if (candidate == null) return null;
    return String(candidate);
  }
  return null;
};

const sameId = (a, b) => {
  const left = normalizeId(a);
  const right = normalizeId(b);
  return Boolean(left && right && left === right);
};

const isDeletedForUser = (deletedFor, userId) => {
  const normalizedUserId = normalizeId(userId);
  if (!deletedFor) return false;

  if (typeof deletedFor === 'string') {
    return deletedFor.toLowerCase() === 'everyone' || sameId(deletedFor, normalizedUserId);
  }

  if (Array.isArray(deletedFor)) {
    return deletedFor.some((id) => sameId(id, normalizedUserId));
  }

  if (typeof deletedFor === 'object') {
    const users = Array.isArray(deletedFor?.users) ? deletedFor.users : [];
    if (users.some((id) => sameId(id, normalizedUserId))) return true;
    return sameId(deletedFor?.userId || deletedFor?._id || deletedFor?.id, normalizedUserId);
  }

  return false;
};

const computeSenderType = (senderId, currentUserId) => (
  sameId(senderId, currentUserId) ? 'self' : 'other'
);

const buildDeletePlaceholderText = (isDeletedBySelf) => (
  isDeletedBySelf ? '🗑 You deleted this message' : '🗑 This message was deleted'
);

const generateClientMessageId = () => (
  `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
);

const extractFileName = (nameOrUri = '') => {
  const value = String(nameOrUri || '').trim();
  if (!value) return 'media';
  const withoutQuery = value.split('?')[0];
  const parts = withoutQuery.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'media';
};

const resolveUploadMediaId = (uploadData = {}) => {
  if (uploadData?.mediaId) return String(uploadData.mediaId);
  if (uploadData?._id?.$oid) return String(uploadData._id.$oid);
  if (uploadData?._id) return String(uploadData._id);
  if (uploadData?.id) return String(uploadData.id);
  return null;
};

export default function useChatLogic({ navigation, route }) {
  const dispatch = useDispatch();
  const { isConnected, networkType } = useNetwork();
  const { pickMedia } = useImage();
  const { setActiveChat, markChatRead, onLocalOutgoingMessage, updateLocalLastMessagePreview } = useRealtimeChat();

  const deferRealtimeUpdate = useCallback((fn) => {
    // Ensure provider mutations run after current render/commit cycle.
    setTimeout(() => {
      try {
        fn?.();
      } catch (error) {
        console.warn('deferRealtimeUpdate error', error);
      }
    }, 0);
  }, []);
  const chatMessagesData = useSelector(state => state.chat?.chatMessagesData || state.chat?.data || state.chat);
  
  const ENUM_MESSAGE_TYPES = new Set(['text', 'image', 'video', 'audio', 'file', 'location', 'contact', 'system']);
  const MEDIA_MESSAGE_TYPES = new Set(['image', 'photo', 'video', 'audio', 'file', 'document']);

  const normalizeOutboundMessageType = (value) => {
    const type = String(value || '').toLowerCase();
    if (type === 'photo') return 'image';
    if (type === 'document') return 'file';
    if (ENUM_MESSAGE_TYPES.has(type)) return type;
    return 'file';
  };
  
  const isMediaMessageType = (value) => {
    const type = String(value || '').toLowerCase();
    return MEDIA_MESSAGE_TYPES.has(type);
  };
  
  const normalizeMessagePayloadWithDownloadFlag = (messageType, payload = {}) => {
    const base = payload && typeof payload === 'object' ? { ...payload } : {};
    if (isMediaMessageType(messageType)) {
      return {
        ...base,
        isMediaDownloaded: Boolean(base?.isMediaDownloaded),
      };
    }
    if ('isMediaDownloaded' in base) {
      delete base.isMediaDownloaded;
    }
    return base;
  };

  const mergePayloadKeepingDownloadState = (existingMessage = {}, incomingMessage = {}) => {
    const resolvedType = incomingMessage?.type || incomingMessage?.mediaType || incomingMessage?.messageType || existingMessage?.type || 'text';
    const mergedLocalUri = incomingMessage?.localUri || existingMessage?.localUri || null;
    const isDownloaded = Boolean(
      existingMessage?.payload?.isMediaDownloaded ||
      incomingMessage?.payload?.isMediaDownloaded ||
      existingMessage?.isMediaDownloaded ||
      incomingMessage?.isMediaDownloaded ||
      mergedLocalUri
    );

    return normalizeMessagePayloadWithDownloadFlag(resolvedType, {
      ...(existingMessage?.payload || {}),
      ...(incomingMessage?.payload || {}),
      isMediaDownloaded: isDownloaded,
    });
  };

  // Build chatData safely from route.params (supports both `item` and `user`)
  const { item, chatId: routeChatId, user } = (route && route.params) || {};
  const routePeerUser = item?.peerUser || user || null;
  const normalizedPeerUser = routePeerUser
    ? {
        ...routePeerUser,
        _id: routePeerUser._id || routePeerUser.userId || routePeerUser.id || null,
      }
    : null;
  const chatData = (item && normalizedPeerUser)
    ? { peerUser: normalizedPeerUser, chatId: item.chatId || item._id || routeChatId || null }
    : (normalizedPeerUser ? { peerUser: normalizedPeerUser, chatId: routeChatId || null } : { peerUser: null, chatId: null });

  // Refs
  const fadeAnimRef = useRef(null);
  const flatListRef = useRef(null);
  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const peerTypingTimeoutRef = useRef(null); // Separate timeout for peer typing
  const appState = useRef(AppState.currentState);
  const presenceCheckInterval = useRef(null);
  const hasSyncedRef = useRef(false);
  const chatIdRef = useRef(null);
  const currentUserIdRef = useRef(null);
  const pendingMessagesRef = useRef([]);
  const socketCheckInterval = useRef(null);
  const isComponentMounted = useRef(true);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const searchTimeoutRef = useRef(null);
  const initialLoadDoneRef = useRef(false);
  const heartbeatIntervalRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const backgroundAwayTimeoutRef = useRef(null);
  const lastInteractionAtRef = useRef(Date.now());
  const queuedManualPresenceRef = useRef([]);
  const queuedMediaStatusRef = useRef([]);
  const queuedMediaUploadsRef = useRef([]);
  const mediaUploadQueueInFlightRef = useRef(false);
  const flushQueuedMediaUploadsRef = useRef(async () => {});
  const mediaStatusInFlightRef = useRef(false);
  const mediaStatusProcessedRef = useRef(new Set());
  const presenceUpdateVersionRef = useRef(0);
  const readMarkTimeoutRef = useRef(null);
  const lastMessageSyncAtRef = useRef(0);
  const forceReloadPendingRef = useRef(false);
  const visibilityReadTimeoutRef = useRef(null);
  const loadMoreInFlightRef = useRef(false);
  const fetchOlderCursorRef = useRef(null);
  const lastInitializedChatRef = useRef(null);
  const isHardReloadingRef = useRef(false);
  const deletedTombstonesRef = useRef({});
  const pendingPreviewSyncRef = useRef(false);
  const localSaveTimeoutRef = useRef(null);
  const socketHandlerRegistryRef = useRef(new Map());

  // State
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [messages, setMessages] = useState([]);
  const [allMessages, setAllMessages] = useState([]);
  const [selectedMessage, setSelectedMessages] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [chatId, setChatId] = useState(null);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [userStatus, setUserStatus] = useState("");
  const [lastSeen, setLastSeen] = useState(null);
  const [customStatus, setCustomStatus] = useState("");
  const [presenceDetails, setPresenceDetails] = useState(null);
  const [manualPresencePending, setManualPresencePending] = useState(false);
  
  // FIXED: Separate typing states for local user and peer
  const [isPeerTyping, setIsPeerTyping] = useState(false); // Peer is typing
  const [isLocalTyping, setIsLocalTyping] = useState(false); // Local user is typing
  
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isManualReloading, setIsManualReloading] = useState(false);
  const [isLoadingFromLocal, setIsLoadingFromLocal] = useState(true);
  const [hasLoadedFromAPI, setHasLoadedFromAPI] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [showMediaOptions, setShowMediaOptions] = useState(false);
  const [downloadedMedia, setDownloadedMedia] = useState({});
  const [mediaViewer, setMediaViewer] = useState({ visible: false, uri: null, type: null });
  const [pendingMedia, setPendingMedia] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState({});
  const [uploadProgress, setUploadProgress] = useState({});
  const [mediaDownloadStates, setMediaDownloadStates] = useState({});
  const [isChatMuted, setIsChatMuted] = useState(Boolean(item?.isMuted));
  const [muteUntil, setMuteUntil] = useState(item?.muteUntil || null);
  const [editingMessage, setEditingMessage] = useState(null);

  const buildMediaStatusQueueStorageKey = useCallback(
    () => `${MEDIA_STATUS_QUEUE_KEY}_${currentUserIdRef.current || 'anon'}`,
    []
  );

  const buildMediaUploadQueueStorageKey = useCallback(
    () => `${MEDIA_UPLOAD_QUEUE_KEY}_${currentUserIdRef.current || 'anon'}`,
    []
  );

  const buildMediaStatusEventKey = useCallback((chatIdValue, messageIdValue) => {
    const normalizedChatId = normalizeId(chatIdValue);
    const normalizedMessageId = normalizeId(messageIdValue);
    if (!normalizedChatId || !normalizedMessageId) return null;
    return `${normalizedChatId}:${normalizedMessageId}:downloaded`;
  }, []);

  const getOrCreateDeviceId = useCallback(async () => {
    try {
      const existing = await AsyncStorage.getItem('deviceId');
      if (existing && String(existing).trim()) {
        return String(existing);
      }
      const generated = `device_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      await AsyncStorage.setItem('deviceId', generated);
      return generated;
    } catch (error) {
      console.error('getOrCreateDeviceId error', error);
      return `device_fallback_${Date.now()}`;
    }
  }, []);

  const validateMediaMessagePayload = useCallback((messagePayload = {}) => {
    const missing = [];
    if (!messagePayload?.mediaId) missing.push('mediaId');
    if (!messagePayload?.mediaUrl) missing.push('mediaUrl');
    if (!messagePayload?.mediaThumbnailUrl) missing.push('mediaThumbnailUrl');
    if (!messagePayload?.mediaMeta || typeof messagePayload.mediaMeta !== 'object') {
      missing.push('mediaMeta');
    }
    return {
      isValid: missing.length === 0,
      missing,
    };
  }, []);

  const createMediaMessagePayload = useCallback(({
    uploadResponse,
    file,
    messageType,
    senderId,
    senderDeviceId,
    receiverId,
    chatId,
    messageId,
  }) => {
    const uploadData = uploadResponse?.data || uploadResponse || {};
    const normalizedMessageType = normalizeOutboundMessageType(
      uploadData?.fileCategory || messageType || file?.type || 'file'
    );
    const generatedMessageId = String(
      messageId ||
      uploadData?.messageId ||
      uploadData?._id?.$oid ||
      uploadData?._id ||
      generateClientMessageId()
    );
    const resolvedFileName = file?.name || extractFileName(file?.uri || uploadData?.previewUrl || uploadData?.thumbnailUrl);
    const resolvedMimeType = file?.type || uploadData?.mimeType || `application/${normalizedMessageType}`;
    const mediaId = resolveUploadMediaId(uploadData) || generatedMessageId;

    return {
      chatId,
      chatType: 'private',
      messageId: generatedMessageId,
      senderId,
      senderDeviceId,
      receiverId,
      messageType: normalizedMessageType,
      mediaId,
      mediaUrl: uploadData?.previewUrl || uploadData?.mediaUrl || '',
      mediaThumbnailUrl: uploadData?.thumbnailUrl || uploadData?.previewUrl || '',
      mediaMeta: {
        fileName: resolvedFileName,
        fileSize: uploadData?.sizeAfter || file?.size || null,
        mimeType: resolvedMimeType,
        width: uploadData?.width || null,
        height: uploadData?.height || null,
      },
      status: 'sent',
      text: file?.name || '',
      createdAt: uploadData?.createdAt || new Date().toISOString(),
    };
  }, [normalizeOutboundMessageType]);

  const persistMediaStatusQueue = useCallback(async (queueItems) => {
    try {
      await AsyncStorage.setItem(buildMediaStatusQueueStorageKey(), JSON.stringify(queueItems || []));
    } catch (error) {
      console.error('persistMediaStatusQueue error', error);
    }
  }, [buildMediaStatusQueueStorageKey]);

  const loadQueuedMediaStatusUpdates = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(buildMediaStatusQueueStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      const queue = Array.isArray(parsed) ? parsed : [];
      queuedMediaStatusRef.current = queue;
      queue.forEach((item) => {
        const key = buildMediaStatusEventKey(item?.chatId, item?.messageId);
        if (key && item?.isMediaDownloaded === true) {
          mediaStatusProcessedRef.current.add(key);
        }
      });
    } catch (error) {
      console.error('loadQueuedMediaStatusUpdates error', error);
      queuedMediaStatusRef.current = [];
    }
  }, [buildMediaStatusQueueStorageKey, buildMediaStatusEventKey]);

  const persistMediaUploadQueue = useCallback(async (queueItems) => {
    try {
      await AsyncStorage.setItem(buildMediaUploadQueueStorageKey(), JSON.stringify(queueItems || []));
    } catch (error) {
      console.error('persistMediaUploadQueue error', error);
    }
  }, [buildMediaUploadQueueStorageKey]);

  const loadQueuedMediaUploads = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(buildMediaUploadQueueStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      queuedMediaUploadsRef.current = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('loadQueuedMediaUploads error', error);
      queuedMediaUploadsRef.current = [];
    }
  }, [buildMediaUploadQueueStorageKey]);

  const persistMessagesForChatImmediate = useCallback(async (chatIdValue, nextMessages) => {
    try {
      const normalizedChatId = normalizeId(chatIdValue || chatIdRef.current);
      if (!normalizedChatId) return;
      const localKey = getChatMessagesKey(normalizedChatId);
      if (!localKey) return;
      const rows = Array.isArray(nextMessages) ? nextMessages.slice(0, MAX_LOCAL_SAVE) : [];
      await AsyncStorage.setItem(localKey, JSON.stringify(rows));
    } catch (error) {
      console.error('persistMessagesForChatImmediate error', error);
    }
  }, []);

  const applyMediaDownloadedStateLocally = useCallback(async ({ messageId, chatId: targetChatId, isMediaDownloaded = true, localUri = null }) => {
    const normalizedMessageId = normalizeId(messageId);
    if (!normalizedMessageId) return;

    const applyPatch = (msg) => {
      const msgId = normalizeId(msg?.serverMessageId || msg?.id || msg?.tempId || msg?.mediaId);
      if (!sameId(msgId, normalizedMessageId)) return msg;
      if (msg?.isDeleted || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system') {
        return msg;
      }

      const nextPayload = normalizeMessagePayloadWithDownloadFlag(
        msg.type || msg.mediaType || msg.messageType,
        { ...(msg.payload || {}), isMediaDownloaded: Boolean(isMediaDownloaded) }
      );

      return {
        ...msg,
        localUri: localUri || msg.localUri || null,
        payload: nextPayload,
        isMediaDownloaded: Boolean(nextPayload?.isMediaDownloaded || localUri || msg?.localUri),
        downloadStatus: Boolean(isMediaDownloaded)
          ? MEDIA_DOWNLOAD_STATUS.DOWNLOADED
          : (msg?.downloadStatus || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED),
      };
    };

    setMessages((prev) => prev.map(applyPatch));

    let cachedUpdated = null;
    setAllMessages((prev) => {
      const updated = prev.map(applyPatch);
      cachedUpdated = updated;
      return updated;
    });

    if (cachedUpdated) {
      await persistMessagesForChatImmediate(targetChatId || chatIdRef.current, cachedUpdated);
    }
  }, [persistMessagesForChatImmediate]);

  const markMediaRemovedLocally = useCallback(async (mediaIds = []) => {
    const normalizedIds = Array.isArray(mediaIds)
      ? mediaIds.map(normalizeId).filter(Boolean)
      : [];

    if (normalizedIds.length === 0) return;

    const idSet = new Set(normalizedIds);
    const matchesMedia = (msg = {}) => {
      const candidates = [
        normalizeId(msg?.mediaId),
        normalizeId(msg?.serverMessageId),
        normalizeId(msg?.id),
        normalizeId(msg?.tempId),
      ].filter(Boolean);
      return candidates.some((candidate) => idSet.has(candidate));
    };

    const applyPatch = (msg = {}) => {
      if (!matchesMedia(msg)) return msg;
      const nextPayload = normalizeMessagePayloadWithDownloadFlag(
        msg.type || msg.mediaType || msg.messageType,
        { ...(msg.payload || {}), isMediaDownloaded: false }
      );

      return {
        ...msg,
        localUri: null,
        payload: nextPayload,
        isMediaDownloaded: false,
        downloadStatus: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
      };
    };

    setDownloadedMedia((prev) => {
      const next = { ...prev };
      normalizedIds.forEach((id) => {
        delete next[id];
      });
      return next;
    });

    setMediaDownloadStates((prev) => {
      const next = { ...prev };
      normalizedIds.forEach((id) => {
        next[id] = {
          ...(next[id] || { mediaId: id }),
          status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
          progress: 0,
          localPath: null,
          error: null,
          updatedAt: Date.now(),
        };
      });
      return next;
    });

    setMessages((prev) => prev.map(applyPatch));

    let cachedUpdated = null;
    setAllMessages((prev) => {
      const updated = prev.map(applyPatch);
      cachedUpdated = updated;
      return updated;
    });

    if (cachedUpdated) {
      await persistMessagesForChatImmediate(chatIdRef.current, cachedUpdated);
    }
  }, [persistMessagesForChatImmediate]);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        await mediaDownloadManager.rehydrate();
        const cachedMap = await mediaDownloadManager.getCachedMediaMap();
        if (!mounted) return;

        const nextDownloaded = {};
        const nextStates = {};

        Object.entries(cachedMap || {}).forEach(([mediaId, row]) => {
          if (!mediaId) return;
          if (row?.localPath) {
            nextDownloaded[String(mediaId)] = row.localPath;
          }
          nextStates[String(mediaId)] = {
            mediaId: String(mediaId),
            status: row?.downloadStatus || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
            progress: row?.downloadStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADED ? 100 : 0,
            localPath: row?.localPath || null,
            error: null,
          };
        });

        setDownloadedMedia((prev) => ({ ...prev, ...nextDownloaded }));
        setMediaDownloadStates((prev) => ({ ...prev, ...nextStates }));
      } catch (error) {
        console.warn('media download bootstrap failed', error);
      }
    };

    bootstrap().catch(() => {});

    const unsubscribe = mediaDownloadManager.subscribe((event) => {
      if (!mounted || !event?.mediaId) return;

      const mediaId = String(event.mediaId);
      const state = event?.state || {};
      const stateStatus = String(state?.status || '').toUpperCase();

      setMediaDownloadStates((prev) => ({
        ...prev,
        [mediaId]: {
          ...(prev[mediaId] || { mediaId, status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED, progress: 0 }),
          status: stateStatus || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
          progress: Number(state?.progress || 0),
          localPath: state?.localPath || null,
          error: state?.error || null,
          updatedAt: Date.now(),
        },
      }));

      if (stateStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADING) {
        setDownloadProgress((prev) => ({
          ...prev,
          [mediaId]: Math.max(0, Math.min(1, Number(state?.progress || 0) / 100)),
        }));
      }

      if (stateStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADED && state?.localPath) {
        setDownloadedMedia((prev) => ({ ...prev, [mediaId]: state.localPath }));
        setDownloadProgress((prev) => {
          const copy = { ...prev };
          delete copy[mediaId];
          return copy;
        });
      }

      if (stateStatus === MEDIA_DOWNLOAD_STATUS.FAILED) {
        setDownloadProgress((prev) => {
          const copy = { ...prev };
          delete copy[mediaId];
          return copy;
        });
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Color helper
  const pastelColors = [
    "#833AB4", "#1DB954", "#128C7E", "#075E54", "#777737",
    "#F56040", "#34B7F1", "#25D366", "#FF5A5F", "#3A3A3A",
    "#FF0000", "#00A699",
  ];
  const getUserColor = useCallback((str) => {
    if (!str) return pastelColors[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % pastelColors.length;
    return pastelColors[index];
  }, []);

  // Keep refs in sync
  useEffect(() => { 
    chatIdRef.current = chatId; 
    currentUserIdRef.current = currentUserId; 
  }, [chatId, currentUserId]);

  // Keyboard listeners
  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
      if (readMarkTimeoutRef.current) clearTimeout(readMarkTimeoutRef.current);
      if (visibilityReadTimeoutRef.current) clearTimeout(visibilityReadTimeoutRef.current);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      if (backgroundAwayTimeoutRef.current) clearTimeout(backgroundAwayTimeoutRef.current);
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
      if (localSaveTimeoutRef.current) {
        clearTimeout(localSaveTimeoutRef.current);
        localSaveTimeoutRef.current = null;
      }
    };
  }, []);

  // Focus effect: ensure socket reconnect on focus
  useEffect(() => {
    hasSyncedRef.current = false;
    isComponentMounted.current = true;
    reconnectAttempts.current = 0;
    initialLoadDoneRef.current = false;
    checkAndReconnectSocket();
    return () => {
      isComponentMounted.current = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
      if (readMarkTimeoutRef.current) clearTimeout(readMarkTimeoutRef.current);
      if (visibilityReadTimeoutRef.current) clearTimeout(visibilityReadTimeoutRef.current);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      if (backgroundAwayTimeoutRef.current) clearTimeout(backgroundAwayTimeoutRef.current);
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch network connectivity
  useEffect(() => {
    if (isConnected) {
      reconnectAttempts.current = 0;
      checkAndReconnectSocket();
      if (queuedManualPresenceRef.current.length > 0) {
        flushQueuedManualPresence();
      }
      if (queuedMediaStatusRef.current.length > 0) {
        flushQueuedMediaStatusUpdates();
      }
      if (queuedMediaUploadsRef.current.length > 0) {
        flushQueuedMediaUploadsRef.current();
      }
    } else {
      setUserStatus("offline");
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    }
  }, [isConnected, checkAndReconnectSocket]);

  useEffect(() => {
    if (isConnected && isSocketConnected()) {
      emitPresenceActivity({ reason: "network-switch", metadata: { networkType } });
    }
  }, [networkType, isConnected]);

  // App state changes
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener("change", nextAppState => {
      if (appState.current.match(/inactive|background/) && nextAppState === "active") {
        reconnectAttempts.current = 0;
        checkAndReconnectSocket();
        emitPresenceActivity({ reason: "app-foreground" });
        startHeartbeat();
        resetIdleTimer();
        if (backgroundAwayTimeoutRef.current) {
          clearTimeout(backgroundAwayTimeoutRef.current);
          backgroundAwayTimeoutRef.current = null;
        }

        const socket = socketRef.current || getSocket();
        if (socket && isSocketConnected()) {
          socket.emit("app:state", {
            state: "foreground",
            userId: currentUserIdRef.current,
            chatId: chatIdRef.current,
            networkType,
          });
        }

        requestUserPresence();
        if (chatIdRef.current) {
          fetchAndSyncMessagesViaSocket(chatIdRef.current, { limit: SOCKET_FETCH_LIMIT });
        }
        hasSyncedRef.current = false;
      } else if (nextAppState.match(/inactive|background/)) {
        if (!hasSyncedRef.current && chatIdRef.current) {
          syncMessagesToAPI();
          hasSyncedRef.current = true;
        }
        // FIXED: Use isLocalTyping state
        if (isLocalTyping) {
          sendTypingStatus(false);
          setIsLocalTyping(false);
        }

        stopHeartbeat();
        if (idleTimeoutRef.current) {
          clearTimeout(idleTimeoutRef.current);
          idleTimeoutRef.current = null;
        }

        const socket = socketRef.current || getSocket();
        if (socket && isSocketConnected()) {
          socket.emit("app:state", {
            state: "background",
            userId: currentUserIdRef.current,
            chatId: chatIdRef.current,
            networkType,
          });
        }

        if (backgroundAwayTimeoutRef.current) {
          clearTimeout(backgroundAwayTimeoutRef.current);
        }

        backgroundAwayTimeoutRef.current = setTimeout(() => {
          if (!isConnected || appState.current === "active") return;
          updatePresenceStatus(PRESENCE_STATUS.AWAY, { reason: "background-timeout" });
        }, PRESENCE_BACKGROUND_AWAY_DELAY);

        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      }
      appState.current = nextAppState;
    });
    return () => { appStateSubscription.remove(); };
  }, [isLocalTyping, checkAndReconnectSocket, isConnected, networkType]);

  // Periodic socket check
  useEffect(() => {
    socketCheckInterval.current = setInterval(() => {
      if (isComponentMounted.current && appState.current === 'active') {
        const socket = getSocket();
        if (!socket || !isSocketConnected()) {
          checkAndReconnectSocket();
        } else {
          reconnectAttempts.current = 0;
        }
      }
    }, PRESENCE_HEARTBEAT_INTERVAL);
    return () => { if (socketCheckInterval.current) clearInterval(socketCheckInterval.current); };
  }, [checkAndReconnectSocket]);

  // Filter messages by current chat ID
  useEffect(() => {
    if (chatId && allMessages.length > 0) {
      const filteredMessages = allMessages.filter(msg => {
        if (msg.chatId && msg.chatId === chatId) return true;

        const peerId = normalizeId(chatData.peerUser?._id);
        const myId = normalizeId(currentUserId);
        if (!peerId || !myId) return false;

        return (
          (sameId(msg.receiverId, myId) && sameId(msg.senderId, peerId)) ||
          (sameId(msg.senderId, myId) && sameId(msg.receiverId, peerId))
        );
      });
      
      const sorted = filteredMessages.sort((a, b) => 
        (b.timestamp || 0) - (a.timestamp || 0)
      );
      
      setMessages(sorted);
    }
  }, [chatId, allMessages, chatData.peerUser?._id, currentUserId]);

  useEffect(() => {
    if (!chatIdRef.current || !currentUserIdRef.current || allMessages.length === 0) return;
    if (appState.current !== 'active') return;
    scheduleMarkVisibleUnreadAsRead();
  }, [allMessages, scheduleMarkVisibleUnreadAsRead]);

  // Initialize chat on mount or when peer user changes
  useEffect(() => {
    if (chatData.peerUser) {
      console.log('🔄 Initializing chat for user:', chatData.peerUser?._id);
      
      setMessages([]);
      setAllMessages([]);
      setCurrentPage(1);
      setHasMoreMessages(true);
      setHasLoadedFromAPI(false);
      setSearchResults([]);
      setCurrentSearchIndex(-1);
      setIsSearching(false);
      setIsPeerTyping(false); // Reset typing state
      setIsLocalTyping(false);
      initialLoadDoneRef.current = false;
      
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (peerTypingTimeoutRef.current) {
        clearTimeout(peerTypingTimeoutRef.current);
        peerTypingTimeoutRef.current = null;
      }
      if (presenceCheckInterval.current) {
        clearInterval(presenceCheckInterval.current);
        presenceCheckInterval.current = null;
      }
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      if (backgroundAwayTimeoutRef.current) {
        clearTimeout(backgroundAwayTimeoutRef.current);
        backgroundAwayTimeoutRef.current = null;
      }
      stopHeartbeat();
      
      if (socketRef.current) {
        removeSocketListeners(socketRef.current);
      }
      
      initializeChat();
    } else {
      setIsLoadingInitial(false);
      setIsLoadingFromLocal(false);
    }

    return () => {
      console.log('🧹 Cleaning up chat for user:', chatData.peerUser?._id);

      const unreadOnExit = allMessages
        .filter(msg =>
          msg.chatId === chatIdRef.current &&
          msg.senderId &&
          msg.senderId !== currentUserIdRef.current &&
          msg.status !== 'seen'
        )
        .map(msg => msg.serverMessageId || msg.id || msg.tempId)
        .filter(Boolean);

      if (unreadOnExit.length > 0) {
        markMessagesAsRead(unreadOnExit);
      }

      deferRealtimeUpdate(() => setActiveChat(null));
      
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (peerTypingTimeoutRef.current) {
        clearTimeout(peerTypingTimeoutRef.current);
        peerTypingTimeoutRef.current = null;
      }
      if (presenceCheckInterval.current) {
        clearInterval(presenceCheckInterval.current);
        presenceCheckInterval.current = null;
      }
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      if (backgroundAwayTimeoutRef.current) {
        clearTimeout(backgroundAwayTimeoutRef.current);
        backgroundAwayTimeoutRef.current = null;
      }
      stopHeartbeat();
      
      const socket = getSocket();
      if (socket && isSocketConnected() && currentUserIdRef.current && chatIdRef.current) {
        socket.emit('user:status', { 
          userId: currentUserIdRef.current, 
          status: 'offline', 
          chatId: chatIdRef.current 
        });
      }
      
      if (socketRef.current) {
        removeSocketListeners(socketRef.current);
      }
      
      initialLoadDoneRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatData.peerUser?._id]);

  /* ========== Socket connection & reconnection logic ========== */
  const checkAndReconnectSocket = useCallback(async () => {
    if (reconnectTimeoutRef.current) return;
    const socket = getSocket();
    if (!socket || !isSocketConnected()) {
      if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
        Alert.alert(
          "Connection Error",
          "Unable to connect to server. Please check your internet connection and try again.",
          [
            { text: "Retry", onPress: () => { reconnectAttempts.current = 0; checkAndReconnectSocket(); } },
            { text: "Cancel", style: "cancel" }
          ]
        );
        return;
      }
      reconnectAttempts.current += 1;
      try {
        await reconnectSocket(navigation);
        const backoffDelay = Math.min(1000 * Math.pow(2, reconnectAttempts.current - 1), 10000);
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          const newSocket = getSocket();
          if (newSocket && isSocketConnected()) {
            socketRef.current = newSocket;
            reconnectAttempts.current = 0;
            if (chatIdRef.current && currentUserIdRef.current) {
              setupSocketListeners(newSocket, chatIdRef.current);
              newSocket.emit('chat:join', { chatId: chatIdRef.current, userId: currentUserIdRef.current }, (response) => {});
              newSocket.emit('user:status', { userId: currentUserIdRef.current, status: 'online', chatId: chatIdRef.current });
              markUserOnline("socket-reconnect");
              startHeartbeat();
              flushQueuedManualPresence();
              flushQueuedMediaStatusUpdates();
              requestUserPresence();
            }
          } else {
            if (isComponentMounted.current) checkAndReconnectSocket();
          }
        }, backoffDelay);
      } catch (error) {
        reconnectTimeoutRef.current = null;
        if (isComponentMounted.current) {
          const retryDelay = Math.min(2000 * Math.pow(2, reconnectAttempts.current - 1), 15000);
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            checkAndReconnectSocket();
          }, retryDelay);
        }
      }
    } else {
      socketRef.current = socket;
      reconnectAttempts.current = 0;
    }
  }, [navigation]);

  /* ========== Chat initialization ========== */
  const initializeChat = async () => {
    if (initialLoadDoneRef.current) {
      console.log('⏭️ Skipping initialization - already done');
      return;
    }
    
    try {
      const userInfo = await AsyncStorage.getItem("userInfo");
      if (!userInfo) {
        setIsLoadingInitial(false);
        setIsLoadingFromLocal(false);
        return;
      }
      const user = JSON.parse(userInfo);
      const userId = user._id || user.id;
      setCurrentUserId(userId);
      currentUserIdRef.current = userId;

      const generatedChatId = chatData.chatId || routeChatId || `u_${userId}_${chatData.peerUser._id}`;
      if (lastInitializedChatRef.current && lastInitializedChatRef.current === generatedChatId) {
        setIsLoadingInitial(false);
        setIsLoadingFromLocal(false);
        initialLoadDoneRef.current = true;
        return;
      }
      setChatId(generatedChatId);
      chatIdRef.current = generatedChatId;
      deferRealtimeUpdate(() => {
        setActiveChat(generatedChatId);
        markChatRead(generatedChatId);
      });
      lastInitializedChatRef.current = generatedChatId;

      setMessages([]);
      setAllMessages([]);

      await loadQueuedManualPresence();
      await loadQueuedMediaStatusUpdates();
      await loadQueuedMediaUploads();
      await loadDeletedTombstones(generatedChatId);

      const localCount = await loadMessagesFromLocal(generatedChatId);

      await checkAndReconnectSocket();

      const socket = getSocket();
      if (socket && isSocketConnected()) {
        socketRef.current = socket;
        setupSocketListeners(socket, generatedChatId);
        requestUserPresence();
        socket.emit('user:status', { userId, status: 'online', chatId: generatedChatId });
        socket.emit('chat:join', { chatId: generatedChatId, userId }, (response) => {});
        // Emit message:read:all — mark all messages as read when user opens the chat
        socket.emit('message:read:all', { chatId: generatedChatId, senderId: userId });
        markUserOnline("chat-init");
        startHeartbeat();
        resetIdleTimer();
        flushQueuedManualPresence();
        flushQueuedMediaStatusUpdates();
        flushQueuedMediaUploadsRef.current();
        presenceCheckInterval.current = setInterval(() => {
          if (isSocketConnected()) requestUserPresence();
          else checkAndReconnectSocket();
        }, PRESENCE_POLL_INTERVAL);
      } else {
        setUserStatus("offline");
      }

      if (localCount === 0) {
        fetchAndSyncMessagesViaSocket(generatedChatId, { limit: SOCKET_FETCH_LIMIT });
        fetchMessagesFromAPI(generatedChatId);
      } else {
        fetchAndSyncMessagesViaSocket(generatedChatId, { limit: SOCKET_FETCH_LIMIT, syncOnly: true });
      }
      scheduleMarkVisibleUnreadAsRead();

      setIsLoadingInitial(false);
      setIsLoadingFromLocal(false);
      initialLoadDoneRef.current = true;
    } catch (error) {
      console.error("initializeChat error", error);
      setIsLoadingInitial(false);
      setIsLoadingFromLocal(false);
    }
  };

  /* ========== Local storage helpers ========== */
  const loadMessagesFromLocal = async (chatIdParam) => {
    try {
      const localKey = getChatMessagesKey(chatIdParam);
      if (!localKey) return 0;
      const savedMessages = await AsyncStorage.getItem(localKey);
      const clearedAt = await getChatClearedAt(chatIdParam);
  
      if (!savedMessages) return 0;
  
      const parsed = JSON.parse(savedMessages);
      const filteredParsed = Array.isArray(parsed)
        ? parsed.filter((msg) => {
            const ts = Number(msg?.timestamp || new Date(msg?.createdAt || 0).getTime() || 0);
            if (!clearedAt || !ts) return true;
            return ts > clearedAt;
          })
        : [];
      
      const processed = filteredParsed.map(msg => {
        const normalizedSenderId = normalizeId(msg.senderId);
        const normalizedReceiverId = normalizeId(msg.receiverId);
        const normalizedCurrentUser = normalizeId(currentUserIdRef.current);
        const normalizedPeer = normalizeId(chatData?.peerUser?._id);

        // Fix stale 'sending'/'uploaded' status for messages that already have a serverMessageId
        // This means the upload succeeded but the status wasn't updated before the user left the screen
        let resolvedStatus = msg.status;
        if ((resolvedStatus === 'sending' || resolvedStatus === 'uploaded') && msg.serverMessageId && msg.synced) {
          resolvedStatus = 'sent';
        }

        let base = {
          ...msg,
          status: resolvedStatus,
          senderId: normalizedSenderId,
          senderType: msg.senderType || computeSenderType(normalizedSenderId, normalizedCurrentUser),
          receiverId: normalizedReceiverId,
          payload: normalizeMessagePayloadWithDownloadFlag(msg?.type || msg?.mediaType || msg?.messageType || 'text', msg?.payload || {}),
          isMediaDownloaded: Boolean(msg?.payload?.isMediaDownloaded || msg?.isMediaDownloaded || msg?.localUri),
        };

        if (!base.chatId && normalizedCurrentUser && normalizedPeer) {
          const belongsToCurrentChat = (
            (sameId(normalizedSenderId, normalizedCurrentUser) && sameId(normalizedReceiverId, normalizedPeer)) ||
            (sameId(normalizedSenderId, normalizedPeer) && sameId(normalizedReceiverId, normalizedCurrentUser))
          );
          if (belongsToCurrentChat) {
            base.chatId = chatIdParam;
          }
        }

        if (sameId(normalizedSenderId, normalizedCurrentUser) && base.type !== 'text') {
          if (msg.localUri) {
            console.log('📖 Loading sender media with localUri:', msg.id, msg.localUri);
            return {
              ...base,
              previewUrl: msg.localUri,
              mediaUrl: msg.localUri,
              localUri: msg.localUri
            };
          }
          
          if (msg.payload?.file?.uri) {
            console.log('📖 Recovering localUri from payload:', msg.id);
            return {
              ...base,
              localUri: msg.payload.file.uri,
              previewUrl: msg.payload.file.uri,
              mediaUrl: msg.payload.file.uri
            };
          }
        }
        return base;
      });
  
      const uniqueMessages = deduplicateMessages(processed);
      const sorted = uniqueMessages.sort(
        (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
      );
  
      setAllMessages(prev => {
        const existingMap = new Map();
        prev.forEach(m => {
          const key = m.serverMessageId || m.id || m.tempId;
          if (key) existingMap.set(key, m);
        });
        
        const newMessages = sorted.filter(m => {
          const key = m.serverMessageId || m.id || m.tempId;
          return !existingMap.has(key);
        });
        
        console.log('📖 Loaded', newMessages.length, 'new messages from local');
        return [...prev, ...newMessages];
      });

      return sorted.length;
  
    } catch (err) {
      console.error("Error loading from local storage:", err);
      return 0;
    }
  };

  const normalizeMessageStatus = useCallback((status) => {
    const s = (status || '').toString().toLowerCase();
    if (s === 'read') return 'seen';
    if (s === 'seen') return 'seen';
    if (s === 'delivered') return 'delivered';
    if (s === 'sent') return 'sent';
    if (s === 'uploaded') return 'uploaded';
    if (s === 'sending') return 'sending';
    if (s === 'failed') return 'failed';
    return undefined;
  }, []);

  const getMessageStatusPriority = useCallback((status) => {
    const normalized = normalizeMessageStatus(status) || status;
    if (normalized === 'seen') return 5;
    if (normalized === 'delivered') return 4;
    if (normalized === 'sent') return 3;
    if (normalized === 'uploaded') return 2;
    if (normalized === 'sending') return 1;
    if (normalized === 'failed') return 0;
    return 0;
  }, [normalizeMessageStatus]);

  const deletedKeyForChat = useCallback((chatIdParam) => `${DELETED_TOMBSTONES_PREFIX}${chatIdParam}`, []);

  const persistDeletedTombstones = useCallback(async () => {
    try {
      if (!chatIdRef.current) return;
      await AsyncStorage.setItem(
        deletedKeyForChat(chatIdRef.current),
        JSON.stringify(deletedTombstonesRef.current || {})
      );
    } catch (error) {
      console.error('persistDeletedTombstones error', error);
    }
  }, [deletedKeyForChat]);

  const loadDeletedTombstones = useCallback(async (chatIdParam) => {
    try {
      if (!chatIdParam) return;
      const raw = await AsyncStorage.getItem(deletedKeyForChat(chatIdParam));
      const parsed = raw ? JSON.parse(raw) : {};
      deletedTombstonesRef.current = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      deletedTombstonesRef.current = {};
      console.error('loadDeletedTombstones error', error);
    }
  }, [deletedKeyForChat]);

  const registerDeletedTombstone = useCallback(async (messageId, meta = {}) => {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId) return;
    deletedTombstonesRef.current = {
      ...(deletedTombstonesRef.current || {}),
      [normalizedId]: {
        deletedFor: 'everyone',
        deletedBy: normalizeId(meta?.deletedBy) || null,
        placeholderText: meta?.placeholderText || null,
        updatedAt: Date.now(),
      },
    };
    await persistDeletedTombstones();
  }, [persistDeletedTombstones]);

  const removeDeletedTombstone = useCallback(async (messageId) => {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId || !deletedTombstonesRef.current?.[normalizedId]) return;
    const next = { ...(deletedTombstonesRef.current || {}) };
    delete next[normalizedId];
    deletedTombstonesRef.current = next;
    await persistDeletedTombstones();
  }, [persistDeletedTombstones]);

  const normalizeIncomingMessage = useCallback((apiMsg) => {
    const mediaMeta = apiMsg?.mediaMeta || apiMsg?.payload?.mediaMeta || {};
    const serverId = apiMsg?._id || apiMsg?.messageId || apiMsg?.id;
    const normalizedMediaId = normalizeId(
      apiMsg?.mediaId ||
      mediaMeta?.mediaId ||
      apiMsg?.serverMessageId ||
      apiMsg?._id ||
      apiMsg?.messageId ||
      apiMsg?.id
    );
    const createdAtRaw = apiMsg?.createdAt || apiMsg?.timestamp || new Date().toISOString();
    const createdAt = typeof createdAtRaw === 'number' ? new Date(createdAtRaw).toISOString() : createdAtRaw;

    const normalizedSenderId = normalizeId(apiMsg?.senderId);
    const normalizedReceiverId = normalizeId(apiMsg?.receiverId);
    const normalizedCurrentUser = normalizeId(currentUserIdRef.current);
    const normalizedServerId = normalizeId(serverId);
    const tombstone = normalizedServerId ? deletedTombstonesRef.current?.[normalizedServerId] : null;
    const resolvedDeletedFor = apiMsg?.deletedFor ?? apiMsg?.deleteFor ?? apiMsg?.delete_type ?? null;
    const resolvedIsDeleted = apiMsg?.isDeleted === true || isDeletedForUser(resolvedDeletedFor, normalizedCurrentUser) || Boolean(tombstone);
    const resolvedDeletedBy = normalizeId(apiMsg?.deletedBy) || normalizeId(tombstone?.deletedBy) || null;
    const isDeletedBySelf = sameId(resolvedDeletedBy, normalizedCurrentUser);
    const resolvedPlaceholderText = apiMsg?.placeholderText || tombstone?.placeholderText || buildDeletePlaceholderText(isDeletedBySelf);

    const incomingRawType = String(apiMsg?.messageType || apiMsg?.fileCategory || apiMsg?.type || '').toLowerCase();
    const incomingCategory = String(apiMsg?.fileCategory || mediaMeta?.fileCategory || '').toLowerCase();
    const hasMediaHints = Boolean(
      apiMsg?.mediaUrl ||
      apiMsg?.mediaThumbnailUrl ||
      apiMsg?.url ||
      apiMsg?.previewUrl ||
      apiMsg?.thumbnailUrl ||
      apiMsg?.payload?.mediaUrl ||
      apiMsg?.payload?.mediaThumbnailUrl ||
      apiMsg?.payload?.previewUrl ||
      apiMsg?.payload?.thumbnailUrl ||
      apiMsg?.payload?.file?.uri ||
      apiMsg?.payload?.file?.url ||
      apiMsg?.payload?.file?.previewUrl ||
      apiMsg?.payload?.file?.thumbnailUrl ||
      apiMsg?.payload?.fileName ||
      apiMsg?.mimeType
    );
    const resolvedMessageType = incomingRawType === 'media'
      ? (incomingCategory || 'file')
      : (isMediaMessageType(incomingRawType)
        ? incomingRawType
        : (ENUM_MESSAGE_TYPES.has(incomingRawType)
          ? incomingRawType
          : (hasMediaHints ? 'file' : 'text')));
    const payloadFile = apiMsg?.payload?.file || {};
    const resolvedMediaUrl =
      apiMsg?.mediaUrl ||
      apiMsg?.payload?.mediaUrl ||
      apiMsg?.previewUrl ||
      apiMsg?.payload?.previewUrl ||
      apiMsg?.url ||
      payloadFile?.url ||
      payloadFile?.uri ||
      null;
    const resolvedMediaThumbnailUrl =
      apiMsg?.mediaThumbnailUrl ||
      apiMsg?.payload?.mediaThumbnailUrl ||
      apiMsg?.thumbnailUrl ||
      apiMsg?.payload?.thumbnailUrl ||
      payloadFile?.thumbnailUrl ||
      payloadFile?.previewUrl ||
      apiMsg?.previewUrl ||
      apiMsg?.payload?.previewUrl ||
      resolvedMediaUrl;
    const incomingLocalUri = apiMsg?.localUri || apiMsg?.payload?.localUri || apiMsg?.payload?.file?.uri || null;
    const normalizedPayload = normalizeMessagePayloadWithDownloadFlag(
      resolvedMessageType,
      {
        ...(apiMsg?.payload || {}),
        isMediaDownloaded: Boolean(
          apiMsg?.payload?.isMediaDownloaded ||
          apiMsg?.isMediaDownloaded ||
          incomingLocalUri
        ),
      }
    );

    console.log({
        id: serverId,
        serverMessageId: serverId,
        tempId: serverId,
      mediaId: normalizedMediaId,
        type: resolvedMessageType,
        mediaType: apiMsg?.fileCategory || (isMediaMessageType(resolvedMessageType) ? resolvedMessageType : null),
        text: apiMsg?.text || apiMsg?.content || "",
        time: moment(createdAt).format("hh:mm A"),
        date: moment(createdAt).format("YYYY-MM-DD"),
        senderId: normalizedSenderId,
        senderType: computeSenderType(normalizedSenderId, normalizedCurrentUser),
        receiverId: normalizedReceiverId,
        status: sameId(normalizedSenderId, normalizedCurrentUser)
          ? (normalizeMessageStatus(apiMsg?.status) || "sent")
          : normalizeMessageStatus(apiMsg?.status),
        mediaUrl: resolvedMediaUrl,
        mediaThumbnailUrl: resolvedMediaThumbnailUrl,
        previewUrl: incomingLocalUri || resolvedMediaThumbnailUrl || resolvedMediaUrl,
        createdAt,
        timestamp: new Date(createdAt).getTime(),
        synced: true,
        chatId: apiMsg?.chatId || chatIdRef.current,
        isMediaDownloaded: Boolean(normalizedPayload?.isMediaDownloaded || incomingLocalUri),
        isDeleted: resolvedIsDeleted,
        deletedFor: resolvedDeletedFor,
        deletedBy: resolvedDeletedBy,
        placeholderText: resolvedIsDeleted ? resolvedPlaceholderText : null,
    })

    return {
      id: serverId,
      serverMessageId: serverId,
      tempId: serverId,
      mediaId: normalizedMediaId,
      type: resolvedMessageType,
      mediaType: apiMsg?.fileCategory || (isMediaMessageType(resolvedMessageType) ? resolvedMessageType : null),
      text: apiMsg?.text || apiMsg?.content || "",
      time: moment(createdAt).format("hh:mm A"),
      date: moment(createdAt).format("YYYY-MM-DD"),
      senderId: normalizedSenderId,
      senderType: computeSenderType(normalizedSenderId, normalizedCurrentUser),
      receiverId: normalizedReceiverId,
      status: sameId(normalizedSenderId, normalizedCurrentUser)
        ? (normalizeMessageStatus(apiMsg?.status) || "sent")
        : normalizeMessageStatus(apiMsg?.status),
      mediaUrl: resolvedMediaUrl,
      mediaThumbnailUrl: resolvedMediaThumbnailUrl,
      previewUrl: incomingLocalUri || resolvedMediaThumbnailUrl || resolvedMediaUrl,
      createdAt,
      timestamp: new Date(createdAt).getTime(),
      synced: true,
      chatId: apiMsg?.chatId || chatIdRef.current,
      localUri: incomingLocalUri,
      payload: normalizedPayload,
      mediaMeta,
      isMediaDownloaded: Boolean(normalizedPayload?.isMediaDownloaded || incomingLocalUri),
      downloadStatus: Boolean(normalizedPayload?.isMediaDownloaded || incomingLocalUri)
        ? MEDIA_DOWNLOAD_STATUS.DOWNLOADED
        : MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
      isDeleted: resolvedIsDeleted,
      deletedFor: resolvedDeletedFor,
      deletedBy: resolvedDeletedBy,
      placeholderText: resolvedIsDeleted ? resolvedPlaceholderText : null,
    };
  }, [normalizeMessageStatus]);

  const mergeMessagesIntoState = useCallback((incomingMessages = []) => {
    if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) return;

    setAllMessages(prevMessages => {
      const mergedMessages = [...prevMessages];

      incomingMessages.forEach(raw => {
        const formattedMessage = normalizeIncomingMessage(raw);
        const serverId = formattedMessage.serverMessageId;

        let existingIndex = mergedMessages.findIndex(m =>
          m.serverMessageId === serverId ||
          m.id === serverId ||
          m.tempId === serverId
        );

        if (existingIndex === -1) {
          existingIndex = mergedMessages.findIndex(localMsg =>
            localMsg.senderId === formattedMessage.senderId &&
            Math.abs(
              new Date(localMsg.createdAt).getTime() -
              new Date(formattedMessage.createdAt).getTime()
            ) < 5000
          );
        }

        if (existingIndex !== -1 && mergedMessages[existingIndex]?.localUri) {
          formattedMessage.localUri = mergedMessages[existingIndex].localUri;
          formattedMessage.previewUrl = mergedMessages[existingIndex].localUri;
          formattedMessage.mediaUrl = mergedMessages[existingIndex].localUri;
        }

        if (existingIndex !== -1) {
          const existing = mergedMessages[existingIndex];
          const keepDeletedPlaceholder = existing?.isDeleted === true && formattedMessage?.isDeleted !== true;

          const mergedLocalUri = keepDeletedPlaceholder ? null : (formattedMessage.localUri || existing?.localUri || null);
          const mergedPayload = mergePayloadKeepingDownloadState(existing, {
            ...formattedMessage,
            localUri: mergedLocalUri,
          });

          mergedMessages[existingIndex] = {
            ...existing,
            ...formattedMessage,
            senderType: formattedMessage.senderType || existing.senderType,
            isDeleted: keepDeletedPlaceholder ? true : formattedMessage.isDeleted,
            deletedFor: keepDeletedPlaceholder ? (existing?.deletedFor || 'everyone') : formattedMessage.deletedFor,
            text: keepDeletedPlaceholder ? (existing?.text || 'This message was deleted') : formattedMessage.text,
            type: keepDeletedPlaceholder ? (existing?.type || 'system') : formattedMessage.type,
            mediaUrl: keepDeletedPlaceholder ? null : formattedMessage.mediaUrl,
            previewUrl: keepDeletedPlaceholder ? null : formattedMessage.previewUrl,
            localUri: mergedLocalUri,
            payload: mergedPayload,
            isMediaDownloaded: Boolean(mergedPayload?.isMediaDownloaded || mergedLocalUri),
            downloadStatus: Boolean(mergedPayload?.isMediaDownloaded || mergedLocalUri)
              ? MEDIA_DOWNLOAD_STATUS.DOWNLOADED
              : MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
          };
        } else {
          mergedMessages.push(formattedMessage);
        }
      });

      const uniqueMessages = deduplicateMessages(mergedMessages);
      const sorted = uniqueMessages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      saveMessagesToLocal(sorted);
      return sorted;
    });
  }, [deduplicateMessages, mergePayloadKeepingDownloadState, normalizeIncomingMessage, saveMessagesToLocal]);

  const replaceMessagesForChat = useCallback((incomingMessages = [], targetChatId = null) => {
    const effectiveChatId = targetChatId || chatIdRef.current;
    if (!effectiveChatId) return;

    const normalizedIncoming = Array.isArray(incomingMessages)
      ? incomingMessages.map(normalizeIncomingMessage)
      : [];

    setAllMessages(prevMessages => {
      const otherChats = prevMessages.filter(msg => msg.chatId !== effectiveChatId);
      const existingSameChat = prevMessages.filter(msg => msg.chatId === effectiveChatId);

      const incomingIdSet = new Set(
        normalizedIncoming
          .map(msg => normalizeId(msg?.serverMessageId || msg?.id || msg?.tempId))
          .filter(Boolean)
      );

      const preservedDeleted = existingSameChat.filter((msg) => {
        const isDeletedMessage = Boolean(msg?.isDeleted) || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system';
        if (!isDeletedMessage) return false;
        const msgId = normalizeId(msg?.serverMessageId || msg?.id || msg?.tempId);
        if (!msgId) return false;
        return !incomingIdSet.has(msgId);
      });

      const merged = deduplicateMessages([...otherChats, ...normalizedIncoming, ...preservedDeleted]);
      const sorted = merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      saveMessagesToLocal(sorted);

      const latestTs = sorted
        .filter(msg => msg.chatId === effectiveChatId)
        .reduce((acc, msg) => Math.max(acc, Number(msg?.timestamp || 0)), 0);

      if (latestTs > 0) {
        lastMessageSyncAtRef.current = Math.max(lastMessageSyncAtRef.current, latestTs);
      }

      return sorted;
    });
  }, [deduplicateMessages, normalizeIncomingMessage, saveMessagesToLocal]);

  const markMessagesAsRead = useCallback((messageIds = []) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;

    const socket = socketRef.current || getSocket();
    if (socket && isSocketConnected() && chatIdRef.current && currentUserIdRef.current) {
      socket.emit('message:read:bulk', {
        chatId: chatIdRef.current,
        messageIds,
        senderId: currentUserIdRef.current,
        timestamp: Date.now(),
      });
    }

    setAllMessages(prev => {
      const updated = prev.map(msg => {
        const id = msg.serverMessageId || msg.id || msg.tempId;
        if (!messageIds.includes(id)) return msg;
        return { ...msg, status: 'seen' };
      });
      saveMessagesToLocal(updated);
      return updated;
    });

    if (chatIdRef.current) {
      const targetChatId = chatIdRef.current;
      // Defer provider update to next macrotask to avoid render-phase update warnings.
      deferRealtimeUpdate(() => {
        if (targetChatId) {
          markChatRead(targetChatId);
        }
      });
    }
  }, [markChatRead, saveMessagesToLocal, deferRealtimeUpdate]);

  const markVisibleIncomingAsRead = useCallback((visibleMessageIds = []) => {
    if (!Array.isArray(visibleMessageIds) || visibleMessageIds.length === 0) return;

    if (visibilityReadTimeoutRef.current) {
      clearTimeout(visibilityReadTimeoutRef.current);
    }

    visibilityReadTimeoutRef.current = setTimeout(() => {
      const unreadVisibleIds = allMessages
        .filter(msg => {
          const id = msg.serverMessageId || msg.id || msg.tempId;
          if (!id || !visibleMessageIds.includes(id)) return false;
          if (msg.chatId !== chatIdRef.current) return false;
          if (!msg.senderId || msg.senderId === currentUserIdRef.current) return false;
          return msg.status !== 'seen';
        })
        .map(msg => msg.serverMessageId || msg.id || msg.tempId)
        .filter(Boolean);

      if (unreadVisibleIds.length === 0) return;

      const socket = socketRef.current || getSocket();
      if (socket && isSocketConnected() && chatIdRef.current && currentUserIdRef.current && unreadVisibleIds.length === 1) {
        socket.emit('message:read', {
          messageId: unreadVisibleIds[0],
          chatId: chatIdRef.current,
          senderId: currentUserIdRef.current,
          timestamp: Date.now(),
        });

        // Also emit message:seen for the visible message
        socket.emit('message:seen', {
          messageId: unreadVisibleIds[0],
          chatId: chatIdRef.current,
        });
      }

      markMessagesAsRead(unreadVisibleIds);
    }, 500);
  }, [allMessages, markMessagesAsRead]);

  const scheduleMarkVisibleUnreadAsRead = useCallback(() => {
    if (readMarkTimeoutRef.current) {
      clearTimeout(readMarkTimeoutRef.current);
    }

    readMarkTimeoutRef.current = setTimeout(() => {
      const unreadIds = allMessages
        .filter(msg =>
          (msg.chatId === chatIdRef.current) &&
          msg.senderId &&
          msg.senderId !== currentUserIdRef.current &&
          msg.status !== 'seen'
        )
        .map(msg => msg.serverMessageId || msg.id || msg.tempId)
        .filter(Boolean);

      if (unreadIds.length > 0) {
        markMessagesAsRead(unreadIds);
      }
    }, READ_MARK_DELAY);
  }, [allMessages, markMessagesAsRead]);

  const deduplicateMessages = useCallback((messagesArray) => {
    const uniqueMap = new Map();
    // Track tempId→serverMessageId links so temp and server versions merge
    const tempToServerMap = new Map();

    messagesArray.forEach(msg => {
      // Build cross-reference: if a message has both tempId and serverMessageId, link them
      if (msg.tempId && msg.serverMessageId && msg.tempId !== msg.serverMessageId) {
        tempToServerMap.set(msg.tempId, msg.serverMessageId);
      }
    });

    messagesArray.forEach(msg => {
      const sender = normalizeId(msg?.senderId) || 'unknown';
      const receiver = normalizeId(msg?.receiverId) || 'unknown';
      const type = (msg?.type || msg?.messageType || 'text').toString();
      const tsBucket = Number(msg?.timestamp || 0);
      const textBucket = (msg?.text || '').toString().slice(0, 48);

      // Primary key: prefer serverMessageId, then check if tempId maps to a known serverMessageId
      let key =
        msg.serverMessageId ||
        (msg.tempId && tempToServerMap.get(msg.tempId)) ||
        msg.id ||
        msg.tempId ||
        `${sender}_${receiver}_${type}_${tsBucket}_${textBucket}`;

      if (!key) return;

      if (uniqueMap.has(key)) {
        const existing = uniqueMap.get(key);

        // Prefer the version with serverMessageId (server-confirmed)
        if (msg.serverMessageId && !existing.serverMessageId) {
          // Merge: keep localUri from existing if new doesn't have it
          const merged = { ...msg };
          if (existing.localUri && !merged.localUri) merged.localUri = existing.localUri;
          if (existing.previewUrl && !merged.previewUrl) merged.previewUrl = existing.previewUrl;
          uniqueMap.set(key, merged);
          return;
        }

        if (msg.localUri && !existing.localUri) {
          uniqueMap.set(key, msg);
          return;
        }

        if ((msg.timestamp || 0) > (existing.timestamp || 0)) {
          uniqueMap.set(key, msg);
          return;
        }

      } else {
        uniqueMap.set(key, msg);
      }
    });

    return Array.from(uniqueMap.values());
  }, []);

  const saveMessagesToLocal = useCallback(async (msgs) => {
    try {
      if (!chatIdRef.current || !msgs) return;
      const localKey = getChatMessagesKey(chatIdRef.current);
      if (!localKey) return;

      const uniqueMessages = deduplicateMessages(msgs);
      const messagesToSave = uniqueMessages.slice(0, MAX_LOCAL_SAVE);

      const cleanMessages = messagesToSave.map(msg => ({
        ...msg,
        senderType: msg.senderType || computeSenderType(msg.senderId, currentUserIdRef.current),
        localUri: msg.localUri || null,
      }));

      if (localSaveTimeoutRef.current) {
        clearTimeout(localSaveTimeoutRef.current);
      }

      localSaveTimeoutRef.current = setTimeout(async () => {
        try {
          const clearedAt = await getChatClearedAt(chatIdRef.current);
          const newestTimestamp = cleanMessages.reduce((latest, msg) => {
            const candidate = Number(msg?.timestamp || new Date(msg?.createdAt || 0).getTime() || 0);
            return candidate > latest ? candidate : latest;
          }, 0);

          if (clearedAt > 0 && newestTimestamp > 0 && newestTimestamp <= clearedAt) {
            await AsyncStorage.setItem(localKey, JSON.stringify([]));
            return;
          }

          await AsyncStorage.setItem(localKey, JSON.stringify(cleanMessages));
        } catch (err) {
          console.error("Failed to save to local storage:", err);
        }
      }, LOCAL_SAVE_DEBOUNCE_MS);
    } catch (err) {
      console.error("Failed to save to local storage:", err);
    }
  }, [deduplicateMessages]);

  const applyDeleteToLocalStorage = useCallback(async (messageId, isDeletedForEveryone, options = {}) => {
    try {
      if (!chatIdRef.current || !messageId) return;
      const localKey = getChatMessagesKey(chatIdRef.current);
      if (!localKey) return;
      const savedMessages = await AsyncStorage.getItem(localKey);
      if (!savedMessages) return;

      const parsed = JSON.parse(savedMessages);
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      const deletedBy = normalizeId(options?.deletedBy) || normalizeId(currentUserIdRef.current);
      const isDeletedBySelf = sameId(deletedBy, currentUserIdRef.current);

      const updated = isDeletedForEveryone
        ? parsed.map((msg) => {
            const isMatch = sameId(msg?.id, messageId) || sameId(msg?.serverMessageId, messageId) || sameId(msg?.tempId, messageId);
            if (!isMatch) return msg;
            return {
              ...msg,
              type: 'system',
              text: 'This message was deleted',
              isDeleted: true,
              deletedFor: 'everyone',
              deletedBy,
              placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
              mediaUrl: null,
              previewUrl: null,
              localUri: null,
            };
          })
        : parsed.filter((msg) => !(
            sameId(msg?.id, messageId) ||
            sameId(msg?.serverMessageId, messageId) ||
            sameId(msg?.tempId, messageId)
          ));

      const deduped = deduplicateMessages(updated).slice(0, MAX_LOCAL_SAVE);
      await AsyncStorage.setItem(localKey, JSON.stringify(deduped));
    } catch (err) {
      console.error('Failed to apply delete in local storage:', err);
    }
  }, [deduplicateMessages]);

  const applyDeleteEveryoneToChatStorage = useCallback(async (chatIdParam, messageId, options = {}) => {
    try {
      const normalizedChatId = normalizeId(chatIdParam);
      const normalizedMessageId = normalizeId(messageId);
      if (!normalizedChatId || !normalizedMessageId) {
        return { ok: false, updated: false, reason: 'missing-required-fields' };
      }

      const localKey = getChatMessagesKey(normalizedChatId);
      if (!localKey) {
        return { ok: false, updated: false, reason: 'invalid-local-key' };
      }
      const savedMessages = await AsyncStorage.getItem(localKey);
      if (!savedMessages) {
        return { ok: true, updated: false, reason: 'chat-not-found', localKey };
      }

      let parsed = [];
      try {
        parsed = JSON.parse(savedMessages);
      } catch {
        return { ok: false, updated: false, reason: 'invalid-json', localKey };
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { ok: true, updated: false, reason: 'no-messages', localKey };
      }

      console.log('🧪 [B:LOCAL:BEFORE]', {
        chatId: normalizedChatId,
        messageId: normalizedMessageId,
        count: parsed.length,
        matched: parsed.some((m) =>
          String(m?.id) === String(normalizedMessageId) ||
          String(m?.serverMessageId) === String(normalizedMessageId) ||
          String(m?.tempId) === String(normalizedMessageId)
        ),
      });

      const deletedBy = normalizeId(options?.deletedBy) || normalizeId(currentUserIdRef.current);
      const isDeletedBySelf = sameId(deletedBy, currentUserIdRef.current);

      let didUpdate = false;
      const updated = parsed.map((msg) => {
        const isMatch =
          sameId(msg?.id, normalizedMessageId) ||
          sameId(msg?.serverMessageId, normalizedMessageId) ||
          sameId(msg?.tempId, normalizedMessageId);

        if (!isMatch) return msg;
        didUpdate = true;

        return {
          ...msg,
          type: 'system',
          text: 'This message was deleted',
          isDeleted: true,
          deletedFor: 'everyone',
          deletedBy,
          placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
          mediaUrl: null,
          previewUrl: null,
          localUri: null,
        };
      });

      if (!didUpdate) {
        return { ok: true, updated: false, reason: 'message-not-found', localKey };
      }

      const deduped = deduplicateMessages(updated).slice(0, MAX_LOCAL_SAVE);
      await AsyncStorage.setItem(localKey, JSON.stringify(deduped));

      console.log('🧪 [B:LOCAL:AFTER]', {
        chatId: normalizedChatId,
        messageId: normalizedMessageId,
        updated: didUpdate,
        count: deduped.length,
      });

      return { ok: true, updated: true, localKey, messages: deduped };
    } catch (error) {
      console.error('applyDeleteEveryoneToChatStorage error', error);
      return { ok: false, updated: false, reason: 'storage-error', error };
    }
  }, [deduplicateMessages]);

  const updateChatListLastMessagePreview = useCallback((messagesArray) => {
    if (!chatIdRef.current) return;
    const sameChatMessages = (messagesArray || [])
      .filter((msg) => {
        if (msg?.chatId && msg.chatId === chatIdRef.current) return true;
        const peerId = normalizeId(chatData?.peerUser?._id);
        const myId = normalizeId(currentUserIdRef.current);
        if (!peerId || !myId) return false;
        return (
          (sameId(msg?.senderId, myId) && sameId(msg?.receiverId, peerId)) ||
          (sameId(msg?.senderId, peerId) && sameId(msg?.receiverId, myId))
        );
      })
      .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));

    const latestVisible = sameChatMessages.find((msg) => !(msg?.isDeleted || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system'));

    if (latestVisible) {
      updateLocalLastMessagePreview({
        chatId: chatIdRef.current,
        lastMessage: {
          text: latestVisible.text || '',
          type: latestVisible.type || 'text',
          senderId: latestVisible.senderId || null,
          status: latestVisible.status || null,
          createdAt: latestVisible.createdAt || new Date(latestVisible.timestamp || Date.now()).toISOString(),
          isDeleted: false,
        },
        lastMessageAt: latestVisible.createdAt || new Date(latestVisible.timestamp || Date.now()).toISOString(),
        lastMessageType: latestVisible.type || 'text',
        lastMessageSender: latestVisible.senderId || null,
      });
      return;
    }

    updateLocalLastMessagePreview({
      chatId: chatIdRef.current,
      lastMessage: {
        text: 'No messages yet',
        type: 'text',
        senderId: null,
        status: null,
        createdAt: null,
        isDeleted: false,
      },
      lastMessageAt: null,
      lastMessageType: 'text',
      lastMessageSender: null,
    });
  }, [updateLocalLastMessagePreview, chatData?.peerUser?._id]);

  const applyChatClearedLocally = useCallback(async (targetChatId, scope = 'me') => {
    const normalizedChatId = normalizeId(targetChatId || chatIdRef.current);
    if (!normalizedChatId) return;

    const isCurrentChat = sameId(normalizedChatId, chatIdRef.current);
    deferRealtimeUpdate(() => markChatRead(normalizedChatId));

    if (isCurrentChat) {
      if (localSaveTimeoutRef.current) {
        clearTimeout(localSaveTimeoutRef.current);
        localSaveTimeoutRef.current = null;
      }
      setMessages([]);
      setAllMessages([]);
      setHasMoreMessages(false);
      setCurrentPage(1);
    }

    try {
      await clearChatLocalArtifacts(normalizedChatId, { markCleared: true });
      await AsyncStorage.removeItem(deletedKeyForChat(normalizedChatId));
      if (isCurrentChat) {
        deletedTombstonesRef.current = {};
      }
    } catch (error) {
      console.error('applyChatClearedLocally storage cleanup error', error);
    }

    updateLocalLastMessagePreview({
      chatId: normalizedChatId,
      lastMessage: {
        text: scope === 'everyone' ? 'Chat cleared' : 'No messages yet',
        type: 'text',
        senderId: null,
        status: null,
        createdAt: null,
        isDeleted: false,
      },
      lastMessageAt: null,
      lastMessageType: 'text',
      lastMessageSender: null,
    });
  }, [deletedKeyForChat, markChatRead, updateLocalLastMessagePreview, deferRealtimeUpdate]);

  const clearChatForMe = useCallback(async () => {
    const targetChatId = normalizeId(chatIdRef.current);
    const userId = normalizeId(currentUserIdRef.current);
    if (!targetChatId || !userId) {
      throw new Error('Missing chat or user id');
    }

    try {
      const response = await apiCall('POST', 'user/chat/clear/me', {
        chatId: targetChatId,
        userId,
      });

      const hasFailure = response && (
        response.success === false ||
        response.status === false ||
        response.ok === false ||
        response.error
      );
      if (hasFailure) {
        throw new Error(response?.message || 'clear/me failed');
      }
      const clearType = String(response?.clearType || response?.data?.clearType || '').toLowerCase();
      if (clearType && clearType !== 'me') {
        throw new Error(`Unexpected clearType: ${clearType}`);
      }

      await removeMessagesByChatId(targetChatId);
      await applyChatClearedLocally(targetChatId, 'me');
      return { success: true };
    } catch (error) {
      console.error('clearChatForMe API error', error);
      throw error;
    }
  }, [applyChatClearedLocally]);

  const clearChatForEveryone = useCallback(async () => {
    const targetChatId = normalizeId(chatIdRef.current);
    const userId = normalizeId(currentUserIdRef.current);
    if (!targetChatId || !userId) {
      throw new Error('Missing chat or user id');
    }

    try {
      const response = await apiCall('POST', 'user/chat/clear/everyone', {
        chatId: targetChatId,
        userId,
      });

      const hasFailure = response && (
        response.success === false ||
        response.status === false ||
        response.ok === false ||
        response.error
      );
      if (hasFailure) {
        throw new Error(response?.message || 'clear/everyone failed');
      }
      const clearType = String(response?.clearType || response?.data?.clearType || '').toLowerCase();
      if (clearType && clearType !== 'everyone') {
        throw new Error(`Unexpected clearType: ${clearType}`);
      }

      await removeMessagesByChatId(targetChatId);
      await applyChatClearedLocally(targetChatId, 'everyone');
      return { success: true };
    } catch (error) {
      console.error('clearChatForEveryone API error', error);
      throw error;
    }
  }, [applyChatClearedLocally]);

  /* ========== API fetch handler ========= */
  const fetchMessagesFromAPI = async (chatIdParam) => {
    try {
      dispatch(chatMessage({ chatId: chatIdParam, search: '', page: 1, limit: 50 }));
    } catch (err) {
      console.error("fetchMessagesFromAPI error", err);
    }
  };

  const fetchAndSyncMessagesViaSocket = useCallback((chatIdParam, options = {}) => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !chatIdParam) {
      return;
    }

    const { before = null, limit = SOCKET_FETCH_LIMIT } = options;
    const force = options?.force === true;
    const syncOnly = options?.syncOnly === true;

    const latestMessage = allMessages.reduce((candidate, msg) => {
      const ts = Number(msg?.timestamp || new Date(msg?.createdAt || 0).getTime() || 0);
      if (!candidate) return { msg, ts };
      return ts > candidate.ts ? { msg, ts } : candidate;
    }, null);

    const lastMessageId = String(
      latestMessage?.msg?.serverMessageId ||
      latestMessage?.msg?.id ||
      latestMessage?.msg?.tempId ||
      ''
    ) || null;

    if (!syncOnly) {
      socket.emit('message:fetch', {
        chatId: chatIdParam,
        page: 1,
        limit,
        before,
        force,
      });
    }

    if (force) {
      forceReloadPendingRef.current = true;
      isHardReloadingRef.current = true;
      lastMessageSyncAtRef.current = 0;
    }

    if (!force) {
      socket.emit('message:sync', {
        chatId: chatIdParam,
        lastMessageId,
        limit: Number(limit) > 0 ? Number(limit) : 50,
      });
    }
  }, [allMessages]);

  useEffect(() => {
    const docs = chatMessagesData?.data?.docs || chatMessagesData?.docs || null;
    const hasNext = chatMessagesData?.data?.hasNextPage || chatMessagesData?.hasNextPage || false;
    if (isHardReloadingRef.current) return;
    if (Array.isArray(docs) && currentUserId && chatId && !hasLoadedFromAPI && currentPage === 1 && !isLoadingMore && docs.length > 0) {
      processAPIResponse(docs);
      setHasLoadedFromAPI(true);
      setHasMoreMessages(!!hasNext);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessagesData, currentUserId, chatId, hasLoadedFromAPI, currentPage, isLoadingMore]);

  const processAPIResponse = useCallback((apiMessages) => {
    console.log('🔄 [PROCESS API] Processing', apiMessages.length, 'API messages');

    setAllMessages(prevMessages => {
      const existingMessages = [...prevMessages];
      const mergedMessages = [...existingMessages];

      apiMessages.forEach(apiMsg => {
        const formattedMessage = normalizeIncomingMessage(apiMsg);
        const serverId = formattedMessage.serverMessageId;

        let existingIndex = mergedMessages.findIndex(m =>
          m.serverMessageId === serverId ||
          m.id === serverId
        );

        if (existingIndex === -1) {
          existingIndex = mergedMessages.findIndex(localMsg =>
            sameId(localMsg.senderId, formattedMessage.senderId) &&
            Math.abs(
              new Date(localMsg.createdAt).getTime() -
              new Date(apiMsg.createdAt).getTime()
            ) < 5000
          );
        }

        if (existingIndex !== -1 && mergedMessages[existingIndex]?.localUri) {
          formattedMessage.localUri = mergedMessages[existingIndex].localUri;
          formattedMessage.previewUrl = mergedMessages[existingIndex].localUri;
          formattedMessage.mediaUrl = mergedMessages[existingIndex].localUri;
        }

        if (existingIndex !== -1) {
          const existing = mergedMessages[existingIndex];
          const keepDeletedPlaceholder = existing?.isDeleted === true && formattedMessage?.isDeleted !== true;
          const mergedLocalUri = keepDeletedPlaceholder ? null : (formattedMessage.localUri || existing?.localUri || null);
          const mergedPayload = mergePayloadKeepingDownloadState(existing, {
            ...formattedMessage,
            localUri: mergedLocalUri,
          });

          mergedMessages[existingIndex] = {
            ...existing,
            ...formattedMessage,
            senderType: formattedMessage.senderType || existing.senderType,
            isDeleted: keepDeletedPlaceholder ? true : formattedMessage.isDeleted,
            deletedFor: keepDeletedPlaceholder ? (existing?.deletedFor || 'everyone') : formattedMessage.deletedFor,
            text: keepDeletedPlaceholder ? (existing?.text || 'This message was deleted') : formattedMessage.text,
            type: keepDeletedPlaceholder ? (existing?.type || 'system') : formattedMessage.type,
            mediaUrl: keepDeletedPlaceholder ? null : formattedMessage.mediaUrl,
            previewUrl: keepDeletedPlaceholder ? null : formattedMessage.previewUrl,
            localUri: mergedLocalUri,
            payload: mergedPayload,
            isMediaDownloaded: Boolean(mergedPayload?.isMediaDownloaded || mergedLocalUri),
            downloadStatus: Boolean(mergedPayload?.isMediaDownloaded || mergedLocalUri)
              ? MEDIA_DOWNLOAD_STATUS.DOWNLOADED
              : MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
          };
        } else {
          mergedMessages.push(formattedMessage);
        }
      });

      const uniqueMessages = deduplicateMessages(mergedMessages);
      const sorted = uniqueMessages.sort(
        (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
      );

      saveMessagesToLocal(sorted);
      const latestTs = sorted.reduce((acc, msg) => Math.max(acc, Number(msg?.timestamp || 0)), 0);
      if (latestTs > 0) {
        lastMessageSyncAtRef.current = Math.max(lastMessageSyncAtRef.current, latestTs);
      }
      console.log('✅ [PROCESS API] Final message count:', sorted.length);

      return sorted;
    });

  }, [deduplicateMessages, saveMessagesToLocal, normalizeIncomingMessage, mergePayloadKeepingDownloadState]);

  const syncMessagesToAPI = async () => {
    try {
      if (!chatIdRef.current) return;
      const localKey = getChatMessagesKey(chatIdRef.current);
      if (!localKey) return;
      const savedMessages = await AsyncStorage.getItem(localKey);
      if (!savedMessages) return;
      const parsedMessages = JSON.parse(savedMessages);
      const unsyncedMessages = parsedMessages.filter(msg => msg.senderId === currentUserIdRef.current && !msg.synced && msg.status !== "sending" && msg.status !== "failed");
      if (unsyncedMessages.length > 0) {
        for (const msg of unsyncedMessages) {
          if (msg.payload) msg.synced = true;
        }
        const updatedMessages = parsedMessages.map(msg => unsyncedMessages.find(um => um.id === msg.id) ? { ...msg, synced: true } : msg);
        await AsyncStorage.setItem(localKey, JSON.stringify(updatedMessages));
      }
    } catch (err) {
      console.error("syncMessagesToAPI error", err);
    }
  };

  /* ========== Presence & typing helpers ========== */
  const applyPresenceState = useCallback((rawPayload) => {
    const normalized = normalizePresencePayload(rawPayload);
    if (!normalized) return;

    const incomingVersion = Number(rawPayload?.version || rawPayload?.data?.version || 0);
    if (incomingVersion && incomingVersion < presenceUpdateVersionRef.current) {
      return;
    }
    if (incomingVersion > presenceUpdateVersionRef.current) {
      presenceUpdateVersionRef.current = incomingVersion;
    }

    setPresenceDetails(normalized);
    setUserStatus(normalized.status || PRESENCE_STATUS.OFFLINE);
    setLastSeen(normalized.lastSeen || null);
    setCustomStatus(normalized.customStatus || "");
  }, []);

  const emitPresenceActivity = useCallback(({ reason = "interaction", metadata = {} } = {}) => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !currentUserIdRef.current) return;

    socket.emit("presence:activity", {
      userId: currentUserIdRef.current,
      chatId: chatIdRef.current,
      reason,
      appState: appState.current,
      networkType,
      timestamp: Date.now(),
      metadata,
    });
  }, [networkType]);

  const updatePresenceStatus = useCallback((status, options = {}) => {
    const socket = socketRef.current || getSocket();
    const normalizedStatus = normalizeStatus(status);

    if (!socket || !isSocketConnected() || !currentUserIdRef.current) {
      return;
    }

    const payload = {
      userId: currentUserIdRef.current,
      status: normalizedStatus,
      chatId: chatIdRef.current,
      source: options.source || "system",
      reason: options.reason || "state-update",
      networkType,
      timestamp: Date.now(),
    };

    socket.emit("user:status", payload);
    socket.emit("presence:update:self", payload);
  }, [networkType]);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) return;
    heartbeatIntervalRef.current = setInterval(() => {
      const socket = socketRef.current || getSocket();
      if (!socket || !isSocketConnected() || !currentUserIdRef.current) return;
      socket.emit("presence:heartbeat", {
        userId: currentUserIdRef.current,
        chatId: chatIdRef.current,
        appState: appState.current,
        networkType,
        timestamp: Date.now(),
      });
    }, PRESENCE_HEARTBEAT_INTERVAL);
  }, [networkType]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const resetIdleTimer = useCallback(() => {
    lastInteractionAtRef.current = Date.now();
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
    }

    idleTimeoutRef.current = setTimeout(() => {
      if (appState.current !== "active") return;
      updatePresenceStatus(PRESENCE_STATUS.AWAY, { reason: "idle-timeout" });
    }, PRESENCE_IDLE_TIMEOUT);
  }, [updatePresenceStatus]);

  const markUserOnline = useCallback((reason = "active") => {
    updatePresenceStatus(PRESENCE_STATUS.ONLINE, { reason });
    emitPresenceActivity({ reason });
    resetIdleTimer();
  }, [emitPresenceActivity, resetIdleTimer, updatePresenceStatus]);

  const queueManualPresence = useCallback(async (payload) => {
    try {
      const existing = queuedManualPresenceRef.current || [];
      const updated = [...existing, payload];
      queuedManualPresenceRef.current = updated;
      await AsyncStorage.setItem(
        `${MANUAL_PRESENCE_QUEUE_KEY}_${currentUserIdRef.current || "anon"}`,
        JSON.stringify(updated)
      );
      setManualPresencePending(true);
    } catch (error) {
      console.error("queueManualPresence error", error);
    }
  }, []);

  const flushQueuedManualPresence = useCallback(async () => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected()) return;
    if (!queuedManualPresenceRef.current.length) {
      setManualPresencePending(false);
      return;
    }

    const queue = [...queuedManualPresenceRef.current];
    const failed = [];

    for (const queued of queue) {
      await new Promise((resolve) => {
        socket.emit("presence:manual", queued, (response) => {
          if (!(response?.status === true || response?.success === true || response?.data)) {
            failed.push(queued);
          } else {
            applyPresenceState(response);
          }
          resolve();
        });
      });
    }

    queuedManualPresenceRef.current = failed;
    setManualPresencePending(failed.length > 0);

    try {
      await AsyncStorage.setItem(
        `${MANUAL_PRESENCE_QUEUE_KEY}_${currentUserIdRef.current || "anon"}`,
        JSON.stringify(failed)
      );
    } catch (error) {
      console.error("flushQueuedManualPresence error", error);
    }
  }, [applyPresenceState]);

  const loadQueuedManualPresence = useCallback(async () => {
    try {
      const saved = await AsyncStorage.getItem(
        `${MANUAL_PRESENCE_QUEUE_KEY}_${currentUserIdRef.current || "anon"}`
      );
      const parsed = saved ? JSON.parse(saved) : [];
      queuedManualPresenceRef.current = Array.isArray(parsed) ? parsed : [];
      setManualPresencePending(queuedManualPresenceRef.current.length > 0);
    } catch (error) {
      console.error("loadQueuedManualPresence error", error);
    }
  }, []);

  const emitMediaStatusUpdate = useCallback((payload) => {
    return new Promise((resolve, reject) => {
      const socket = socketRef.current || getSocket();
      if (!socket || !isSocketConnected()) {
        reject(new Error('socket_not_connected'));
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('media_status_timeout'));
      }, MEDIA_STATUS_ACK_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.off('message:media:update:response', onResponse);
      };

      const matchesPayload = (source = {}) => {
        const responseMessageId = normalizeId(source?.messageId || source?.id || source?._id);
        const responseChatId = normalizeId(source?.chatId || source?.chat || source?.roomId);
        return sameId(responseMessageId, payload?.messageId) && sameId(responseChatId, payload?.chatId);
      };

      const onResponse = (responseData) => {
        const source = responseData?.data || responseData || {};
        if (!matchesPayload(source)) return;
        cleanup();
        if (source?.status === false || source?.success === false || responseData?.status === false) {
          reject(new Error(source?.message || responseData?.message || 'media_status_update_failed'));
          return;
        }
        resolve(responseData);
      };

      socket.on('message:media:update:response', onResponse);

      socket.emit('message:media:update', payload, (ack) => {
        if (!ack) return;
        const ackSource = ack?.data || ack;
        if (!matchesPayload(ackSource)) return;
        cleanup();
        if (ack?.status === false || ackSource?.status === false || ackSource?.success === false) {
          reject(new Error(ackSource?.message || ack?.message || 'media_status_update_failed'));
          return;
        }
        resolve(ack);
      });
    });
  }, []);

  const flushQueuedMediaStatusUpdates = useCallback(async () => {
    if (mediaStatusInFlightRef.current) return;

    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !isConnected) {
      return;
    }

    mediaStatusInFlightRef.current = true;
    try {
      const nowTs = Date.now();
      const queue = [...(queuedMediaStatusRef.current || [])];
      const nextQueue = [];

      for (const queued of queue) {
        const normalizedMessageId = normalizeId(queued?.messageId);
        const normalizedChatId = normalizeId(queued?.chatId);
        const eventKey = buildMediaStatusEventKey(normalizedChatId, normalizedMessageId);

        if (!normalizedMessageId || !normalizedChatId) {
          continue;
        }

        const messageDeleted = allMessages.some((msg) => {
          const msgId = normalizeId(msg?.serverMessageId || msg?.id || msg?.tempId || msg?.mediaId);
          if (!sameId(msgId, normalizedMessageId)) return false;
          return msg?.isDeleted || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system';
        });
        if (messageDeleted) {
          if (eventKey) mediaStatusProcessedRef.current.delete(eventKey);
          continue;
        }

        if (Number(queued?.nextAttemptAt || 0) > nowTs) {
          nextQueue.push(queued);
          continue;
        }

        try {
          await emitMediaStatusUpdate({
            messageId: normalizedMessageId,
            chatId: normalizedChatId,
            deviceId: queued?.deviceId,
            isMediaDownloaded: true,
          });
          if (eventKey) mediaStatusProcessedRef.current.add(eventKey);
        } catch (error) {
          const attempts = Number(queued?.attempts || 0) + 1;
          const cappedAttempts = Math.min(attempts, MEDIA_STATUS_MAX_RETRIES);
          const retryDelay = MEDIA_STATUS_BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, cappedAttempts - 1));
          nextQueue.push({
            ...queued,
            attempts: cappedAttempts,
            nextAttemptAt: Date.now() + retryDelay,
            lastError: error?.message || 'media_status_update_failed',
          });
        }
      }

      queuedMediaStatusRef.current = nextQueue;
      await persistMediaStatusQueue(nextQueue);
    } finally {
      mediaStatusInFlightRef.current = false;
    }
  }, [allMessages, buildMediaStatusEventKey, emitMediaStatusUpdate, isConnected, persistMediaStatusQueue]);

  const queueMediaStatusUpdate = useCallback(async ({ messageId, chatId: targetChatId, deviceId, isMediaDownloaded = true }) => {
    const normalizedMessageId = normalizeId(messageId);
    const normalizedChatId = normalizeId(targetChatId || chatIdRef.current);
    if (!normalizedMessageId || !normalizedChatId || !isMediaDownloaded) return;

    const eventKey = buildMediaStatusEventKey(normalizedChatId, normalizedMessageId);
    if (!eventKey) return;

    const existingQueue = [...(queuedMediaStatusRef.current || [])];
    const existingIdx = existingQueue.findIndex((item) => (
      sameId(item?.messageId, normalizedMessageId) && sameId(item?.chatId, normalizedChatId)
    ));

    const queueItem = {
      messageId: normalizedMessageId,
      chatId: normalizedChatId,
      deviceId,
      isMediaDownloaded: true,
      attempts: 0,
      nextAttemptAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (existingIdx >= 0) {
      existingQueue[existingIdx] = {
        ...existingQueue[existingIdx],
        ...queueItem,
      };
    } else if (!mediaStatusProcessedRef.current.has(eventKey)) {
      existingQueue.push(queueItem);
    }

    queuedMediaStatusRef.current = existingQueue;
    await persistMediaStatusQueue(existingQueue);
    await flushQueuedMediaStatusUpdates();
  }, [buildMediaStatusEventKey, flushQueuedMediaStatusUpdates, persistMediaStatusQueue]);

  const retryMediaStatusUpdate = useCallback(async ({ messageId, chatId: targetChatId }) => {
    const normalizedMessageId = normalizeId(messageId);
    const normalizedChatId = normalizeId(targetChatId || chatIdRef.current);
    if (!normalizedMessageId || !normalizedChatId) return;

    const deviceId = await getOrCreateDeviceId();
    const nextQueue = [...(queuedMediaStatusRef.current || [])];
    const idx = nextQueue.findIndex((item) => (
      sameId(item?.messageId, normalizedMessageId) && sameId(item?.chatId, normalizedChatId)
    ));

    const patch = {
      messageId: normalizedMessageId,
      chatId: normalizedChatId,
      deviceId,
      isMediaDownloaded: true,
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
      updatedAt: Date.now(),
    };

    if (idx >= 0) {
      nextQueue[idx] = { ...nextQueue[idx], ...patch };
    } else {
      nextQueue.push(patch);
    }

    queuedMediaStatusRef.current = nextQueue;
    await persistMediaStatusQueue(nextQueue);
    await flushQueuedMediaStatusUpdates();
  }, [flushQueuedMediaStatusUpdates, getOrCreateDeviceId, persistMediaStatusQueue]);

  const retryAllFailedMediaStatusUpdates = useCallback(async () => {
    const nextQueue = (queuedMediaStatusRef.current || []).map((item) => ({
      ...item,
      nextAttemptAt: Date.now(),
      lastError: null,
    }));
    queuedMediaStatusRef.current = nextQueue;
    await persistMediaStatusQueue(nextQueue);
    await flushQueuedMediaStatusUpdates();
  }, [flushQueuedMediaStatusUpdates, persistMediaStatusQueue]);

  const requestUserPresence = useCallback(() => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !chatData.peerUser?._id) {
      setUserStatus(PRESENCE_STATUS.OFFLINE);
      return;
    }

    socket.emit("presence:get", { userId: chatData.peerUser._id }, (response) => {
      if (response?.status === false) {
        setUserStatus(PRESENCE_STATUS.OFFLINE);
        return;
      }
      applyPresenceState(response?.data ? response.data : response);
    });
  }, [chatData.peerUser?._id, applyPresenceState]);

  const setManualPresence = useCallback(async ({ status, customStatus: custom = "", expiresAt = null, metadata = {} }) => {
    const normalizedStatus = normalizeStatus(status);
    const payload = {
      status: normalizedStatus,
      customStatus: custom,
      expiresAt,
      metadata,
      manualOverride: true,
      deviceId: await AsyncStorage.getItem("deviceId"),
      userId: currentUserIdRef.current,
      chatId: chatIdRef.current,
    };

    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected()) {
      await queueManualPresence(payload);
      return { queued: true };
    }

    return new Promise((resolve) => {
      socket.emit("presence:manual", payload, async (response) => {
        if (response?.status === true || response?.success === true || response?.data) {
          resolve({ queued: false, success: true, response });
          return;
        }

        await queueManualPresence(payload);
        resolve({ queued: true, success: false, response });
      });
    });
  }, [queueManualPresence]);

  const clearManualPresence = useCallback(async () => {
    return setManualPresence({
      status: PRESENCE_STATUS.ONLINE,
      customStatus: "",
      expiresAt: null,
      metadata: { clearManual: true },
    });
  }, [setManualPresence]);

  // FIXED: Send typing status with proper error handling
  const sendTypingStatus = useCallback((isTypingNow) => {
    const socket = socketRef.current || getSocket();
    
    if (!socket || !isSocketConnected()) {
      console.warn("⚠️ Cannot send typing status - socket not connected");
      return;
    }
    
    if (!chatIdRef.current || !currentUserIdRef.current || !chatData.peerUser?._id) {
      console.warn("⚠️ Cannot send typing status - missing data", {
        chatId: chatIdRef.current,
        userId: currentUserIdRef.current,
        peerId: chatData.peerUser?._id
      });
      return;
    }

    const payload = { 
      chatId: chatIdRef.current, 
      senderId: currentUserIdRef.current, 
      receiverId: chatData.peerUser._id, 
      isTyping: isTypingNow 
    };

    console.log('📤 [TYPING] Sending typing status:', { isTypingNow, to: chatData.peerUser._id });

    // Emit appropriate event based on typing state
    if (isTypingNow) {
      socket.emit('typing:start', payload);
    } else {
      socket.emit('typing:stop', payload);
    }
  }, [chatData.peerUser]);

  /* ========== Socket listeners setup ========== */
  const removeSocketListeners = useCallback((socket) => {
    if (!socket) return;

    socketHandlerRegistryRef.current.forEach((handlers, eventName) => {
      handlers.forEach((handler) => {
        socket.off(eventName, handler);
      });
    });

    socketHandlerRegistryRef.current.clear();
  }, []);

  // FIXED: Setup socket listeners with proper typing handlers
  const setupSocketListeners = useCallback((socket, currentChatId) => {
    removeSocketListeners(socket);

    const registerSocketHandler = (eventName, handler) => {
      if (!eventName || typeof handler !== 'function') return;
      socket.on(eventName, handler);
      const existing = socketHandlerRegistryRef.current.get(eventName) || new Set();
      existing.add(handler);
      socketHandlerRegistryRef.current.set(eventName, existing);
    };

    const onMessageSentAck = (data) => {
      const messageId = data.messageId || data._id || data.data?.messageId || data.data?._id;
      const tempId = data.tempId || data.data?.tempId;
      if (data.persistenceConfirmed === true || data.status === true || messageId) {
        updateMessageStatus(tempId, 'sent', { messageId, ...data });
      }
    };
    registerSocketHandler('message:sent:ack', onMessageSentAck);

    const onMessageSent = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id;
      const tempId = source?.tempId;
      if (tempId || messageId) {
        updateMessageStatus(tempId || messageId, 'sent', { messageId, ...source });
      }
    };
    registerSocketHandler('message:sent', onMessageSent);

    const onMessageNew = (data) => {
      const chatInPayload = data.chatId || data.chat || data.roomId;
      if (chatInPayload && chatInPayload !== currentChatId) return;
      handleReceivedMessage(data);
    };
    registerSocketHandler('message:new', onMessageNew);

    const onMessageReceived = (data) => { handleReceivedMessage(data); };
    const onMessageDelivered = (data) => { if (data.messageId) updateMessageStatus(data.messageId, 'delivered', data); };
    const onMessageRead = (data) => {
      const source = data?.data || data;
      if (source?.messageId) {
        updateMessageStatus(source.messageId, 'seen', source);
        return;
      }

      const sourceChatId = source?.chatId || source?.chat;
      if (sourceChatId && sourceChatId === currentChatId) {
        setAllMessages(prev => {
          let changed = false;
          const updated = prev.map(msg => {
            const isMine = msg.senderId === currentUserIdRef.current;
            if (!isMine) return msg;
            if (msg.status === 'sent' || msg.status === 'delivered') {
              changed = true;
              return { ...msg, status: 'seen' };
            }
            return msg;
          });
          if (changed) {
            saveMessagesToLocal(updated);
            updateChatListLastMessagePreview(updated);
            return updated;
          }
          return prev;
        });
      }
    };
    registerSocketHandler('message:received', onMessageReceived);
    registerSocketHandler('message:delivered', onMessageDelivered);
    registerSocketHandler('message:read', onMessageRead);

    const onMessageReadBulk = (data) => {
      const source = data?.data || data;
      const messageIds = Array.isArray(source?.messageIds) ? source.messageIds : [];
      if (messageIds.length > 0) {
        setAllMessages(prev => {
          const idSet = new Set(messageIds.map((id) => String(id)));
          let changed = false;
          const updated = prev.map(msg => {
            const id = String(msg.serverMessageId || msg.id || msg.tempId || '');
            if (!idSet.has(id)) return msg;
            if (msg.status === 'seen' || msg.status === 'read') return msg;
            changed = true;
            return { ...msg, status: 'seen' };
          });
          if (changed) {
            saveMessagesToLocal(updated);
            updateChatListLastMessagePreview(updated);
            return updated;
          }
          return prev;
        });
      }
    };
    registerSocketHandler('message:read:bulk', onMessageReadBulk);

    const onMessageStatus = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      const status = source?.status;
      if (!messageId || !status) return;
      updateMessageStatus(messageId, status, source);
    };
    registerSocketHandler('message:status', onMessageStatus);

    // ─── RESPONSE LISTENERS for delivery/read/seen events ───

    const onDeliveredResponse = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      if (!messageId) return;
      updateMessageStatus(messageId, 'delivered', source);
    };
    registerSocketHandler('message:delivered:response', onDeliveredResponse);

    const onReadResponse = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      if (!messageId) return;
      updateMessageStatus(messageId, 'seen', source);
    };
    registerSocketHandler('message:read:response', onReadResponse);

    const onReadBulkResponse = (data) => {
      const source = data?.data || data;
      const results = Array.isArray(source?.results) ? source.results : [];
      const successIds = results.filter(r => r?.success).map(r => String(r?.messageId)).filter(Boolean);
      if (successIds.length === 0) return;

      setAllMessages(prev => {
        const idSet = new Set(successIds);
        let changed = false;
        const updated = prev.map(msg => {
          const id = String(msg.serverMessageId || msg.id || msg.tempId || '');
          if (!idSet.has(id)) return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });
        if (changed) {
          saveMessagesToLocal(updated);
          updateChatListLastMessagePreview(updated);
        }
        return changed ? updated : prev;
      });
    };
    registerSocketHandler('message:read:bulk:response', onReadBulkResponse);

    const onReadAllResponse = (data) => {
      const source = data?.data || data;
      const responseChatId = source?.chatId;
      if (!responseChatId || !sameId(responseChatId, currentChatId)) return;

      // All messages sent by current user in this chat are now read by the peer
      setAllMessages(prev => {
        let changed = false;
        const updated = prev.map(msg => {
          if (msg.chatId !== currentChatId) return msg;
          if (msg.senderId !== currentUserIdRef.current) return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });
        if (changed) {
          saveMessagesToLocal(updated);
          updateChatListLastMessagePreview(updated);
        }
        return changed ? updated : prev;
      });
    };
    registerSocketHandler('message:read:all:response', onReadAllResponse);

    const onSeenResponse = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      if (!messageId) return;
      updateMessageStatus(messageId, 'seen', source);
    };
    registerSocketHandler('message:seen:response', onSeenResponse);

    // ─── MESSAGE EDIT RESPONSE ───
    const onEditResponse = (data) => {
      const source = data?.data || data || {};
      if (source?.status === false || data?.status === false) return;

      const messageId = source?.messageId || source?.id;
      const newText = source?.text || source?.newText;
      const editedChatId = source?.chatId;
      if (!messageId) return;

      // Only apply if it's for this chat
      if (editedChatId && !sameId(editedChatId, currentChatId)) return;

      setAllMessages(prev => {
        let changed = false;
        const updated = prev.map(msg => {
          const id = msg.serverMessageId || msg.id || msg.tempId;
          if (String(id) !== String(messageId)) return msg;
          changed = true;
          return {
            ...msg,
            text: newText || msg.text,
            isEdited: true,
            editedAt: source?.editedAt || Date.now(),
          };
        });
        if (changed) saveMessagesToLocal(updated);
        return changed ? updated : prev;
      });
    };
    registerSocketHandler('message:edit:response', onEditResponse);

    const handleMediaDownloadedUpdate = (data) => {
      const source = data?.data || data || {};
      const updatedMessageId = String(source?.messageId || source?.id || source?._id || '');
      const sourceChatId = source?.chatId || source?.chat || source?.roomId;
      const isMediaDownloaded = Boolean(source?.isMediaDownloaded);

      if (!updatedMessageId || !sameId(sourceChatId, currentChatId)) {
        return;
      }

      applyMediaDownloadedStateLocally({
        messageId: updatedMessageId,
        chatId: sourceChatId,
        isMediaDownloaded,
        localUri: source?.localUri || source?.path || null,
      });
    };

    const handleMediaUpdateResponse = async (data) => {
      const source = data?.data || data || {};
      const responseMessageId = source?.messageId || source?.id || source?._id;
      const responseChatId = source?.chatId || source?.chat || source?.roomId;
      if (!responseMessageId || !responseChatId) {
        return;
      }

      if (source?.status === false || source?.success === false || data?.status === false) {
        const deviceId = await getOrCreateDeviceId();
        await queueMediaStatusUpdate({
          messageId: responseMessageId,
          chatId: responseChatId,
          deviceId,
          isMediaDownloaded: true,
        });
        return;
      }

      if (sameId(responseChatId, currentChatId)) {
        handleMediaDownloadedUpdate(source);
      }
    };

    registerSocketHandler('message:media:update', handleMediaDownloadedUpdate);
    registerSocketHandler('message:media:update:response', handleMediaUpdateResponse);
    registerSocketHandler('message:media:downloaded:update', handleMediaDownloadedUpdate);
    registerSocketHandler('message:media:downloaded:response', handleMediaUpdateResponse);
    registerSocketHandler('message:media:downloaded', handleMediaDownloadedUpdate);

    const onMessageFetchResponse = (data) => {
      const source = data?.data || data;
      const rows = source?.messages || source?.docs || [];
      if (Array.isArray(rows) && rows.length > 0) {
        if (forceReloadPendingRef.current) {
          replaceMessagesForChat(rows, currentChatId);
          forceReloadPendingRef.current = false;
        } else {
          mergeMessagesIntoState(rows);
        }
      } else if (forceReloadPendingRef.current) {
        replaceMessagesForChat([], currentChatId);
        forceReloadPendingRef.current = false;
      }
      if (typeof source?.hasMore === 'boolean') {
        setHasMoreMessages(source.hasMore);
      }
      setIsLoadingMore(false);
      setIsRefreshing(false);
      setIsManualReloading(false);
      loadMoreInFlightRef.current = false;
      fetchOlderCursorRef.current = null;
      isHardReloadingRef.current = false;
    };
    registerSocketHandler('message:fetch:response', onMessageFetchResponse);

    const onMessageSyncResponse = (data) => {
      if (isHardReloadingRef.current) {
        return;
      }

      const source = data?.data || data;
      const rows = source?.messages || [];
      if (Array.isArray(rows) && rows.length > 0) {
        mergeMessagesIntoState(rows);
        const latestTs = rows.reduce((acc, msg) => {
          const ts = new Date(msg?.createdAt || msg?.timestamp || 0).getTime();
          return Math.max(acc, Number.isNaN(ts) ? 0 : ts);
        }, 0);
        if (latestTs > 0) {
          lastMessageSyncAtRef.current = Math.max(lastMessageSyncAtRef.current, latestTs);
        }
      }
    };
    registerSocketHandler('message:sync:response', onMessageSyncResponse);

    const onMessageDeleteEveryone = (data) => {
      console.log('🧪 [B:SOCKET:DELETE:RECV]', {
        event: 'message:delete:everyone',
        raw: data,
      });
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatId = source?.chatId || source?.chat || source?.roomId;
      if (!sameId(chatId, currentChatId)) return;
      handleDeleteMessage(messageId, true, { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    };
    registerSocketHandler('message:delete:everyone', onMessageDeleteEveryone);

    const onMessageDeleteMe = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatId = source?.chatId || source?.chat || source?.roomId;
      const deletedBy = source?.deletedBy;
      const isDeleteForEveryone = (
        source?.deleteForEveryone === true ||
        source?.deleted === true ||
        source?.deleteFor === 'everyone' ||
        source?.delete_type === 'everyone'
      );
      if (isDeleteForEveryone) return;
      if (!sameId(chatId, currentChatId)) return;
      if (!deletedBy || sameId(deletedBy, currentUserIdRef.current)) {
        handleDeleteMessage(messageId, false, { deletedBy });
      }
    };
    registerSocketHandler('message:delete:me', onMessageDeleteMe);

    const onMessageDeleted = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatIdInPayload = source?.chatId || source?.chat || source?.roomId;
      const deleteFor = source?.deleteFor || source?.delete_type || (source?.isDeletedForEveryone ? 'everyone' : 'me') || 'everyone';
      if (!messageId || (chatIdInPayload && !sameId(chatIdInPayload, currentChatId))) return;
      handleDeleteMessage(messageId, deleteFor === 'everyone', { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    };
    registerSocketHandler('message:deleted', onMessageDeleted);

    const onMessageDeleteSync = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatIdInPayload = source?.chatId || source?.chat || source?.roomId;
      if (!messageId || (chatIdInPayload && !sameId(chatIdInPayload, currentChatId))) return;
      handleDeleteMessage(messageId, false, { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    };
    registerSocketHandler('message:delete:sync', onMessageDeleteSync);

    const onMessageDeleteEveryoneResponse = async (data) => {
      console.log('🧪 [B:SOCKET:DELETE:RECV]', {
        event: 'message:delete:everyone:response',
        raw: data,
      });
      const source = data?.data || data || {};

      if (source?.status === false || source?.success === false) {
        Alert.alert("Error", source?.message || "Failed to delete message for everyone");
        return;
      }
      const messageId = source?.messageId || source?._id || source?.id;
      const responseChatId = source?.chatId || source?.chat || source?.roomId;
      const isDeleteForEveryone = (
        source?.deleteForEveryone === true ||
        source?.deleted === true ||
        source?.deleteFor === 'everyone' ||
        source?.delete_type === 'everyone'
      );
      if (!messageId || !responseChatId || !isDeleteForEveryone) {
        console.warn('message:delete:everyone:response invalid payload', source);
        return;
      }
      const deletedBy = source?.deletedBy || source?.senderId || source?.userId || currentUserIdRef.current;
      const normalizedResponseChatId = normalizeId(responseChatId);
      if (sameId(normalizedResponseChatId, currentChatId)) {
        handleDeleteMessage(messageId, true, { deletedBy });
        return;
      }
      const result = await applyDeleteEveryoneToChatStorage(normalizedResponseChatId, messageId, { deletedBy });
      if (!result?.ok) {
        console.warn('message:delete:everyone:response local storage update failed', {
          chatId: normalizedResponseChatId,
          messageId,
          reason: result?.reason,
        });
      }
    };
    registerSocketHandler('message:delete:everyone:response', onMessageDeleteEveryoneResponse);

    const onMessageDeleteResponse = async (data) => {
      console.log('🧪 [B:SOCKET:DELETE:RECV]', {
        event: 'message:delete:response',
        raw: data,
      });

      const source = data?.data || data || {};
      const messageId = source?.messageId || source?._id || source?.id;
      const responseChatId = source?.chatId || source?.chat || source?.roomId;
      const isDeleteForEveryone = (
        source?.deleteForEveryone === true ||
        source?.deleted === true ||
        source?.deleteFor === 'everyone' ||
        source?.delete_type === 'everyone'
      );

      if (!messageId || !responseChatId || !isDeleteForEveryone) {
        return;
      }

      const deletedBy = source?.deletedBy || source?.senderId || source?.userId || currentUserIdRef.current;
      const normalizedResponseChatId = normalizeId(responseChatId);

      if (sameId(normalizedResponseChatId, currentChatId)) {
        handleDeleteMessage(messageId, true, { deletedBy });
        return;
      }

      await applyDeleteEveryoneToChatStorage(normalizedResponseChatId, messageId, { deletedBy });
    };
    registerSocketHandler('message:delete:response', onMessageDeleteResponse);

    const onMessageDeleteMeResponse = (data) => {
      if (data.status === false) Alert.alert("Error", data.message || "Failed to delete message");
    };
    registerSocketHandler('message:delete:me:response', onMessageDeleteMeResponse);

    const onPresenceUpdate = (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:update', onPresenceUpdate);

    const onPresenceGetResponse = (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:get:response', onPresenceGetResponse);

    const onPresenceStatusResponse = (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:status:response', onPresenceStatusResponse);

    const onPresenceManualUpdated = (data) => {
      const sourceUserId = data.userId || data?.data?.userId;
      if (sourceUserId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:manual:updated', onPresenceManualUpdated);

    const onUserOnline = (data) => {
      console.log("user:online", data);
      if (data.userId === chatData.peerUser._id) { 
        setUserStatus(PRESENCE_STATUS.ONLINE);
        setLastSeen(null); 
      }
    };
    registerSocketHandler('user:online', onUserOnline);

    const onUserOffline = (data) => {
      console.log("user:offline", data);
      if (data.userId === chatData.peerUser._id) { 
        setUserStatus(PRESENCE_STATUS.OFFLINE);
        setLastSeen(data.lastSeen || new Date().toISOString()); 
      }
    };
    registerSocketHandler('user:offline', onUserOffline);

    // FIXED: Typing event handlers
    const onTypingStart = (data) => {
      console.log('📨 [TYPING] Received typing:start:', data);
      
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.roomId;
      
      // Only show typing indicator if it's from the peer user and for this chat
      if (senderId === chatData.peerUser._id && 
          (!chatIdInPayload || chatIdInPayload === currentChatId)) {
        
        console.log('👤 [TYPING] Peer is typing');
        setIsPeerTyping(true);
        
        // Clear any existing timeout
        if (peerTypingTimeoutRef.current) {
          clearTimeout(peerTypingTimeoutRef.current);
        }
        
        // Set timeout to hide typing indicator after TYPING_TIMEOUT
        peerTypingTimeoutRef.current = setTimeout(() => {
          console.log('⏰ [TYPING] Peer typing timeout');
          setIsPeerTyping(false);
          peerTypingTimeoutRef.current = null;
        }, TYPING_TIMEOUT);
      }
    };
    registerSocketHandler('typing:start', onTypingStart);

    const onTypingStop = (data) => {
      console.log('📨 [TYPING] Received typing:stop:', data);
      
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.roomId;
      
      if (senderId === chatData.peerUser._id && 
          (!chatIdInPayload || chatIdInPayload === currentChatId)) {
        
        console.log('👤 [TYPING] Peer stopped typing');
        setIsPeerTyping(false);
        
        // Clear timeout
        if (peerTypingTimeoutRef.current) {
          clearTimeout(peerTypingTimeoutRef.current);
          peerTypingTimeoutRef.current = null;
        }
      }
    };
    registerSocketHandler('typing:stop', onTypingStop);

    // Handle recording as typing
    const onTypingRecording = (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.roomId;
      
      if (senderId === chatData.peerUser._id && 
          (!chatIdInPayload || chatIdInPayload === currentChatId)) {
        setIsPeerTyping(true);
        
        if (peerTypingTimeoutRef.current) {
          clearTimeout(peerTypingTimeoutRef.current);
        }
        
        peerTypingTimeoutRef.current = setTimeout(() => {
          setIsPeerTyping(false);
          peerTypingTimeoutRef.current = null;
        }, TYPING_TIMEOUT);
      }
    };
    registerSocketHandler('typing:recording', onTypingRecording);

    const onTypingRecordingUpdate = (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.roomId;
      
      if (senderId === chatData.peerUser._id && 
          (!chatIdInPayload || chatIdInPayload === currentChatId)) {
        setIsPeerTyping(true);
        
        if (peerTypingTimeoutRef.current) {
          clearTimeout(peerTypingTimeoutRef.current);
        }
        
        peerTypingTimeoutRef.current = setTimeout(() => {
          setIsPeerTyping(false);
          peerTypingTimeoutRef.current = null;
        }, TYPING_TIMEOUT);
      }
    };
    registerSocketHandler('typing:recording:update', onTypingRecordingUpdate);

    const onDisconnect = () => {
      setUserStatus(PRESENCE_STATUS.OFFLINE);
      setIsPeerTyping(false); // Reset typing state on disconnect
      stopHeartbeat();
      setTimeout(() => { if (isComponentMounted.current) checkAndReconnectSocket(); }, 2000);
    };
    registerSocketHandler('disconnect', onDisconnect);

    const onConnect = () => {
      reconnectAttempts.current = 0;
      requestUserPresence();
      flushQueuedManualPresence();
      flushQueuedMediaStatusUpdates();
      startHeartbeat();
      markUserOnline("socket-connect");
      socket.emit('chat:join', { chatId: currentChatId, userId: currentUserIdRef.current });
      socket.emit('user:status', { userId: currentUserIdRef.current, status: 'online', chatId: currentChatId });
      if (!initialLoadDoneRef.current) {
        fetchAndSyncMessagesViaSocket(currentChatId, { limit: SOCKET_FETCH_LIMIT });
      } else {
        fetchAndSyncMessagesViaSocket(currentChatId, { limit: SOCKET_FETCH_LIMIT, syncOnly: true });
      }
    };
    registerSocketHandler('connect', onConnect);

    const onChatClearedMe = (data) => {
      const source = data?.data || data || {};
      const targetChatId = source?.chatId || source?.chat || source?.roomId;
      if (!targetChatId) return;
      applyChatClearedLocally(targetChatId, 'me');
    };
    registerSocketHandler('chat:cleared:me', onChatClearedMe);

    const onChatClearedEveryone = (data) => {
      const source = data?.data || data || {};
      const targetChatId = source?.chatId || source?.chat || source?.roomId;
      if (!targetChatId) return;
      applyChatClearedLocally(targetChatId, 'everyone');
    };
    registerSocketHandler('chat:cleared:everyone', onChatClearedEveryone);
  }, [
    chatData.peerUser,
    removeSocketListeners,
    requestUserPresence,
    checkAndReconnectSocket,
    applyPresenceState,
    flushQueuedManualPresence,
    flushQueuedMediaStatusUpdates,
    startHeartbeat,
    stopHeartbeat,
    markUserOnline,
    updateMessageStatus,
    mergeMessagesIntoState,
    replaceMessagesForChat,
    applyDeleteEveryoneToChatStorage,
    applyMediaDownloadedStateLocally,
    getOrCreateDeviceId,
    queueMediaStatusUpdate,
    saveMessagesToLocal,
    applyChatClearedLocally,
  ]);

  const removeDuplicateMessages = useCallback((messagesArr) => {
    const seen = new Set();
    const seenByContent = new Map();
    return messagesArr.filter((msg) => {
      const ids = [msg.serverMessageId, msg.id, msg.tempId].filter(Boolean);
      if (ids.some(id => seen.has(id))) return false;
      const timestamp = new Date(msg.createdAt).getTime();
      const contentKey = `${msg.text}_${msg.senderId}_${Math.floor(timestamp / 5000)}`;
      if (seenByContent.has(contentKey)) return false;
      ids.forEach(id => seen.add(id));
      seenByContent.set(contentKey, true);
      return true;
    });
  }, []);

  const updateMessageStatus = useCallback((tempId, status, serverData = null) => {
    const normalizedStatus = normalizeMessageStatus(status) || status;
    setAllMessages((prevMessages) => {
      let changed = false;
      const updated = prevMessages.map((msg) => {
        const isMatch =
          msg.tempId === tempId ||
          msg.id === tempId ||
          msg.serverMessageId === tempId ||
          (serverData?.messageId && (
            msg.id === serverData.messageId ||
            msg.serverMessageId === serverData.messageId ||
            msg.tempId === tempId
          ));
        if (!isMatch) return msg;

        const preservedLocalUri = msg.localUri;
        const preservedPreview = msg.previewUrl;

        const currentStatus = normalizeMessageStatus(msg.status) || msg.status;
        const currentPriority = getMessageStatusPriority(currentStatus);
        const incomingPriority = getMessageStatusPriority(normalizedStatus);
        const resolvedStatus = incomingPriority >= currentPriority
          ? (normalizedStatus || currentStatus)
          : currentStatus;

        const updatedMsg = { ...msg, status: resolvedStatus };
        if (serverData) {
          const serverMessageId = serverData.messageId || serverData._id;
          if (serverMessageId) {
            updatedMsg.serverMessageId = serverMessageId;
            updatedMsg.id = serverMessageId;
            updatedMsg.synced = true;
          }
          if (serverData.mediaUrl) updatedMsg.mediaUrl = serverData.mediaUrl;
          if (serverData.previewUrl) updatedMsg.previewUrl = serverData.previewUrl;
        }

        if (preservedLocalUri) updatedMsg.localUri = preservedLocalUri;
        if (preservedPreview && !updatedMsg.previewUrl) updatedMsg.previewUrl = preservedPreview;

        if (updatedMsg !== msg) {
          const hasChanged =
            updatedMsg.status !== msg.status ||
            updatedMsg.id !== msg.id ||
            updatedMsg.serverMessageId !== msg.serverMessageId ||
            updatedMsg.synced !== msg.synced ||
            updatedMsg.mediaUrl !== msg.mediaUrl ||
            updatedMsg.previewUrl !== msg.previewUrl;
          if (hasChanged) changed = true;
        }

        return updatedMsg;
      });

      if (!changed) return prevMessages;

      const uniqueMessages = removeDuplicateMessages(updated);
      saveMessagesToLocal(uniqueMessages);
      updateChatListLastMessagePreview(uniqueMessages);
      return uniqueMessages;
    });
  }, [
    removeDuplicateMessages,
    saveMessagesToLocal,
    normalizeMessageStatus,
    getMessageStatusPriority,
    updateChatListLastMessagePreview,
  ]);

  const sendMessageViaSocket = useCallback((payload, tempId) => {
    return new Promise(async (resolve, reject) => {
      try {
        const socket = socketRef.current || getSocket();
        if (!socket || !isSocketConnected()) {
          console.warn("⚠️ sendMessageViaSocket: socket not connected");
          updateMessageStatus(tempId, 'failed');
          return reject(new Error('socket not connected'));
        }

        // Only set 'sending' if not already uploaded (media messages set 'uploaded' after upload completes)
        const isMediaPayload = payload?.mediaUrl || payload?.messageType === 'image' || payload?.messageType === 'video' || payload?.messageType === 'audio' || payload?.messageType === 'file';
        if (!isMediaPayload) {
          updateMessageStatus(tempId, 'sending');
        }

        socket.emit('message:send', payload, (response) => {
          if (response && (response.status === true || response.success === true || response.data)) {
            const serverMessageId = response.data?.messageId || response.data?._id || response.messageId || response._id;
            updateMessageStatus(tempId, 'sent', { messageId: serverMessageId, ...response.data });
            return resolve(response);
          } else if (response && response.status === false) {
            updateMessageStatus(tempId, 'failed');
            return reject(new Error(response.message || 'send failed'));
          } else {
            const serverMessageId = response?.messageId || response?._id;
            if (serverMessageId) {
              updateMessageStatus(tempId, 'sent', { messageId: serverMessageId, ...response });
              return resolve(response);
            }
            updateMessageStatus(tempId, 'failed');
            return reject(new Error('no ack from server'));
          }
        });
      } catch (err) {
        console.error("❌ sendMessageViaSocket error:", err);
        updateMessageStatus(tempId, 'failed');
        return reject(err);
      }
    });
  }, [updateMessageStatus]);

  /* ========== Text send flow ========== */
  const handleSendText = useCallback(async () => {
    if (!text.trim()) return;

    const tempId = `temp_${Date.now()}_${Math.random()}`;
    const timestamp = new Date().toISOString();
    
    const payload = {
      receiverId: chatData.peerUser._id,
      messageType: "text",
      text: text.trim(),
      mediaUrl: '',
      mediaMeta: {},
      replyTo: null,
      forwardedFrom: null,
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      tempId,
      createdAt: timestamp,
    };

    onLocalOutgoingMessage({
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      text: text.trim(),
      createdAt: timestamp,
      peerUser: chatData?.peerUser
        ? {
            ...chatData.peerUser,
            _id: chatData.peerUser._id || chatData.peerUser.userId || chatData.peerUser.id || null,
          }
        : null,
    });
    
    const newMessage = {
      id: tempId,
      tempId,
      type: "text",
      text: text.trim(),
      time: moment(timestamp).format("hh:mm A"),
      date: moment(timestamp).format("YYYY-MM-DD"),
      senderId: currentUserIdRef.current,
      senderType: 'self',
      receiverId: chatData.peerUser._id,
      status: "sending",
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      payload,
      synced: false,
      chatId: chatIdRef.current,
    };

    setText("");
    markUserOnline("send-message");
    
    // FIXED: Stop typing indicator when sending
    if (isLocalTyping) {
      sendTypingStatus(false);
      setIsLocalTyping(false);
    }
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    setAllMessages((prevMessages) => {
      const updatedMessages = [newMessage, ...prevMessages];
      const uniqueMessages = removeDuplicateMessages(updatedMessages);
      saveMessagesToLocal(uniqueMessages);
      return uniqueMessages;
    });

    const socket = socketRef.current || getSocket();
    try {
      if (!socket || !isSocketConnected()) {
        updateMessageStatus(tempId, 'failed');
        await checkAndReconnectSocket();
        return;
      }

      await sendMessageViaSocket(payload, tempId);
    } catch (error) {
      console.error("❌ Send message failed:", error);
      updateMessageStatus(tempId, 'failed');
    }
  }, [text, chatData.peerUser, sendTypingStatus, removeDuplicateMessages, saveMessagesToLocal, updateMessageStatus, checkAndReconnectSocket, isLocalTyping, markUserOnline, onLocalOutgoingMessage, sendMessageViaSocket]);

  const sendLocationMessage = useCallback(async ({ latitude, longitude, address = '', mapPreviewUrl = '' } = {}) => {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('invalid location coordinates');
    }

    const tempId = `temp_location_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();

    const payload = {
      receiverId: chatData.peerUser._id,
      messageType: 'location',
      text: address || 'Shared location',
      mediaUrl: mapPreviewUrl || `https://maps.google.com/?q=${lat},${lng}`,
      mediaMeta: {
        latitude: lat,
        longitude: lng,
        address: address || '',
        mapPreviewUrl: mapPreviewUrl || `https://maps.google.com/?q=${lat},${lng}`,
      },
      replyTo: null,
      forwardedFrom: null,
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      tempId,
      createdAt: timestamp,
    };

    onLocalOutgoingMessage({
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      text: 'Location',
      createdAt: timestamp,
      peerUser: chatData?.peerUser ? {
        ...chatData.peerUser,
        _id: chatData.peerUser._id || chatData.peerUser.userId || chatData.peerUser.id || null,
      } : null,
    });

    setAllMessages((prev) => {
      const localMsg = {
        id: tempId,
        tempId,
        type: 'location',
        mediaType: 'location',
        text: payload.text,
        mediaUrl: payload.mediaUrl,
        previewUrl: payload.mediaUrl,
        mediaMeta: payload.mediaMeta,
        time: moment(timestamp).format('hh:mm A'),
        date: moment(timestamp).format('YYYY-MM-DD'),
        senderId: currentUserIdRef.current,
        senderType: 'self',
        receiverId: chatData.peerUser._id,
        status: 'sending',
        createdAt: timestamp,
        timestamp: new Date(timestamp).getTime(),
        payload,
        chatId: chatIdRef.current,
      };
      const next = deduplicateMessages([localMsg, ...prev]);
      saveMessagesToLocal(next);
      return next;
    });

    await sendMessageViaSocket(payload, tempId);
    return { success: true, tempId };
  }, [chatData.peerUser, deduplicateMessages, onLocalOutgoingMessage, saveMessagesToLocal, sendMessageViaSocket]);

  const sendContactMessage = useCallback(async ({
    contactName, phoneNumber, avatar = '',
    phoneNumbers = [], emails = [], addresses = [],
    company = '', jobTitle = '', birthday = '', note = '',
  } = {}) => {
    const name = String(contactName || '').trim();
    const phone = String(phoneNumber || '').trim();
    if (!name || !phone) {
      throw new Error('missing contact details');
    }

    const allPhones = phoneNumbers.length > 0 ? phoneNumbers : [{ label: 'mobile', number: phone }];

    const tempId = `temp_contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();

    const payload = {
      receiverId: chatData.peerUser._id,
      messageType: 'contact',
      text: name,
      mediaUrl: avatar || '',
      mediaMeta: {
        contactName: name,
        phoneNumber: phone,
        avatar: avatar || '',
        phoneNumbers: allPhones,
        emails: emails || [],
        addresses: addresses || [],
        company: company || '',
        jobTitle: jobTitle || '',
        birthday: birthday || '',
        note: note || '',
      },
      replyTo: null,
      forwardedFrom: null,
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      tempId,
      createdAt: timestamp,
    };

    onLocalOutgoingMessage({
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      text: `Contact: ${name}`,
      createdAt: timestamp,
      peerUser: chatData?.peerUser ? {
        ...chatData.peerUser,
        _id: chatData.peerUser._id || chatData.peerUser.userId || chatData.peerUser.id || null,
      } : null,
    });

    setAllMessages((prev) => {
      const localMsg = {
        id: tempId,
        tempId,
        type: 'contact',
        mediaType: 'contact',
        text: name,
        mediaUrl: avatar || '',
        previewUrl: avatar || '',
        mediaMeta: payload.mediaMeta,
        time: moment(timestamp).format('hh:mm A'),
        date: moment(timestamp).format('YYYY-MM-DD'),
        senderId: currentUserIdRef.current,
        senderType: 'self',
        receiverId: chatData.peerUser._id,
        status: 'sending',
        createdAt: timestamp,
        timestamp: new Date(timestamp).getTime(),
        payload,
        chatId: chatIdRef.current,
      };
      const next = deduplicateMessages([localMsg, ...prev]);
      saveMessagesToLocal(next);
      return next;
    });

    await sendMessageViaSocket(payload, tempId);
    return { success: true, tempId };
  }, [chatData.peerUser, deduplicateMessages, onLocalOutgoingMessage, saveMessagesToLocal, sendMessageViaSocket]);

  /* ========== FIXED: Text input change handler with proper typing ========== */
  const handleTextChange = useCallback((value) => {
    setText(value);
    resetIdleTimer();
    emitPresenceActivity({ reason: "typing" });

    if (value.length > 0) {
      // If we weren't typing before, send typing:start
      if (!isLocalTyping) {
        sendTypingStatus(true);
        setIsLocalTyping(true);
      }
      
      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      
      // Set new timeout to stop typing after inactivity
      typingTimeoutRef.current = setTimeout(() => {
        if (isLocalTyping) {
          sendTypingStatus(false);
          setIsLocalTyping(false);
        }
        typingTimeoutRef.current = null;
      }, TYPING_TIMEOUT);
      
    } else {
      // Text is empty, stop typing
      if (isLocalTyping) {
        sendTypingStatus(false);
        setIsLocalTyping(false);
      }
      
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    }
  }, [sendTypingStatus, isLocalTyping, resetIdleTimer, emitPresenceActivity]);

  const handleReceivedMessage = useCallback(async (msg) => {
    resetIdleTimer();

    const messageId = msg.messageId || msg._id;
    const incomingTempId = msg.tempId;

    console.log('📥 [RECEIVED] New message:', {
      messageId,
      type: msg.messageType,
      mediaMeta: msg.mediaMeta ? Object.keys(msg.mediaMeta) : null,
      hasPayload: !!msg.payload,
    });

    setAllMessages((prevMessages) => {
      // Check if this message already exists (by serverMessageId, id, tempId, or mediaId)
      const exists = prevMessages.some(m =>
        (messageId && (m.id === messageId || m.serverMessageId === messageId || m.tempId === messageId)) ||
        (incomingTempId && (m.tempId === incomingTempId || m.id === incomingTempId)) ||
        (msg.mediaId && (m.mediaId === msg.mediaId))
      );

      if (exists) {
        // If this is our own sent message echoed back, update its status instead of duplicating
        const updatedMessages = prevMessages.map(m => {
          const isMatch = (messageId && (m.id === messageId || m.serverMessageId === messageId || m.tempId === messageId)) ||
            (incomingTempId && (m.tempId === incomingTempId || m.id === incomingTempId)) ||
            (msg.mediaId && (m.mediaId === msg.mediaId));
          if (!isMatch) return m;
          // Update status if the existing message is still in sending/uploaded state
          if (m.status === 'sending' || m.status === 'uploaded') {
            return {
              ...m,
              status: 'sent',
              serverMessageId: messageId || m.serverMessageId,
              id: messageId || m.id,
              synced: true,
            };
          }
          return m;
        });
        const changed = updatedMessages !== prevMessages && updatedMessages.some((m, i) => m !== prevMessages[i]);
        if (changed) {
          saveMessagesToLocal(updatedMessages);
          return updatedMessages;
        }
        console.log('📥 [RECEIVED] Message already exists, skipping');
        return prevMessages;
      }

      const receivedMessage = normalizeIncomingMessage({
        ...msg,
        messageId,
      });

      const updatedMessages = [receivedMessage, ...prevMessages];
      const uniqueMessages = deduplicateMessages(updatedMessages);
      const sorted = uniqueMessages.sort((a, b) => b.timestamp - a.timestamp);
      
      saveMessagesToLocal(sorted);

      const latestTs = sorted.length > 0 ? Number(sorted[0]?.timestamp || 0) : 0;
      if (latestTs > 0) {
        lastMessageSyncAtRef.current = Math.max(lastMessageSyncAtRef.current, latestTs);
      }
      
      return sorted;
    });

    const senderId = msg?.senderId;
    if (senderId && senderId !== currentUserIdRef.current) {
      const messageId = msg?.messageId || msg?._id || msg?.id;
      if (messageId) {
        // Emit message:delivered to server — the message has reached this device
        const socket = socketRef.current || getSocket();
        if (socket && isSocketConnected() && chatIdRef.current) {
          socket.emit('message:delivered', {
            messageId,
            chatId: chatIdRef.current,
            senderId,
          });
        }

        markMessagesAsRead([messageId]);
      }
    }
  }, [saveMessagesToLocal, deduplicateMessages, resetIdleTimer, markMessagesAsRead]);

  const handleDeleteMessage = useCallback((messageId, isDeletedForEveryone, options = {}) => {
    console.log("callback here --- ")
    const deletedBy = normalizeId(options?.deletedBy) || normalizeId(currentUserIdRef.current);
    const isDeletedBySelf = sameId(deletedBy, currentUserIdRef.current);

    if (isDeletedForEveryone) {
      registerDeletedTombstone(messageId, {
        deletedBy,
        placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
      });
    } else {
      removeDeletedTombstone(messageId);
    }

    applyDeleteToLocalStorage(messageId, isDeletedForEveryone, { deletedBy });

    setAllMessages(prevMessages => {
      if (!isDeletedForEveryone) {
        const filtered = prevMessages.filter(msg => !(
          sameId(msg.id, messageId) ||
          sameId(msg.serverMessageId, messageId) ||
          sameId(msg.tempId, messageId)
        ));
        return filtered;
      }

      const updated = prevMessages.map(msg => {
        const isMatch = sameId(msg.id, messageId) || sameId(msg.serverMessageId, messageId) || sameId(msg.tempId, messageId);
        if (!isMatch) return msg;
        return {
          ...msg,
          type: 'system',
          text: 'This message was deleted',
          status: msg.status,
          isDeleted: true,
          deletedFor: 'everyone',
          deletedBy,
          placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
          mediaUrl: null,
          previewUrl: null,
          localUri: null,
        };
      });

      return updated;
    });
    pendingPreviewSyncRef.current = true;
  }, [
    applyDeleteToLocalStorage,
    registerDeletedTombstone,
    removeDeletedTombstone,
  ]);

  useEffect(() => {
    if (!pendingPreviewSyncRef.current) return;
    pendingPreviewSyncRef.current = false;
    saveMessagesToLocal(allMessages);
    updateChatListLastMessagePreview(allMessages);
  }, [allMessages, saveMessagesToLocal, updateChatListLastMessagePreview]);

  const handleToggleSelectMessages = useCallback((messageId) => {
    console.log("messageId === ", messageId)
    setSelectedMessages((prevSelected) => prevSelected.includes(messageId) ? prevSelected.filter((id) => id !== messageId) : [...prevSelected, messageId]);
  }, []);

  const deleteSelectedMessages = useCallback(async (deleteForEveryone) => {
    try {
      const socket = getSocket();

      const selectedResolved = selectedMessage
        .map((messageId) => {
          const found = messages.find(m =>
            sameId(m.id, messageId) ||
            sameId(m.serverMessageId, messageId) ||
            sameId(m.tempId, messageId)
          );
          const resolvedId = found?.serverMessageId || found?.id || found?.tempId || messageId;
          return { found, resolvedId };
        })
        .filter(entry => Boolean(entry.resolvedId));

      selectedResolved.forEach(({ resolvedId }) => {
        handleDeleteMessage(resolvedId, deleteForEveryone, {
          deletedBy: deleteForEveryone ? currentUserIdRef.current : null,
        });
      });

      if (socket && isSocketConnected()) {
        for (const { resolvedId, found } of selectedResolved) {
          console.log('🧪 [A:EMIT:DELETE]', {
            messageId: resolvedId,
            chatId: chatIdRef.current,
            deleteFor: deleteForEveryone ? 'everyone' : 'me',
          });
          console.log('🗑️ Deleting message:', { messageId: resolvedId, chatId: chatIdRef.current, deleteForEveryone });
          if (deleteForEveryone && found && sameId(found.senderId, currentUserIdRef.current)) {
            socket.emit('message:delete', { messageId: resolvedId, chatId: chatIdRef.current, deleteFor: 'everyone' });
            socket.emit('message:delete:everyone', { messageId: resolvedId, chatId: chatIdRef.current });
          } else {
            socket.emit('message:delete', { messageId: resolvedId, chatId: chatIdRef.current, deleteFor: 'me' });
            socket.emit('message:delete:me', { messageId: resolvedId, chatId: chatIdRef.current });
          }
        }
      }
      setSelectedMessages([]);
    } catch (error) {
      Alert.alert("Error", "Failed to delete messages");
    }
  }, [messages, selectedMessage, handleDeleteMessage]);

  // ─── MESSAGE EDITING ───

  const startEditMessage = useCallback((msg) => {
    if (!msg) return;
    const isMine = sameId(msg.senderId, currentUserIdRef.current);
    if (!isMine) return;
    // Only allow editing messages not yet seen
    if (msg.status === 'seen' || msg.status === 'read') return;
    setEditingMessage(msg);
    setSelectedMessages([]);
  }, []);

  const cancelEditMessage = useCallback(() => {
    setEditingMessage(null);
  }, []);

  const submitEditMessage = useCallback(async (newText) => {
    if (!editingMessage || !newText?.trim()) return;

    const messageId = editingMessage.serverMessageId || editingMessage.id || editingMessage.tempId;
    const cId = chatIdRef.current;
    if (!messageId || !cId) return;

    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected()) {
      Alert.alert('Error', 'Not connected. Please try again.');
      return;
    }

    // Optimistic update
    setAllMessages(prev => {
      const updated = prev.map(msg => {
        const id = msg.serverMessageId || msg.id || msg.tempId;
        if (String(id) !== String(messageId)) return msg;
        return {
          ...msg,
          text: newText.trim(),
          isEdited: true,
          editedAt: Date.now(),
        };
      });
      saveMessagesToLocal(updated);
      return updated;
    });

    // Emit socket event
    socket.emit('message:edit', {
      messageId,
      chatId: cId,
      text: newText.trim(),
    });

    setEditingMessage(null);
  }, [editingMessage, saveMessagesToLocal]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedMessage.length === 0) return;
    console.log("selectedMessage ---", selectedMessage)
    const allMyMessages = selectedMessage.every(msgId => {
      const msg = messages.find(m =>
        sameId(m.id, msgId) || sameId(m.serverMessageId, msgId) || sameId(m.tempId, msgId)
      );
      return msg && sameId(msg.senderId, currentUserIdRef.current);
    });
    const options = [{ text: "Cancel", style: "cancel" }, { text: "Delete for me", onPress: () => deleteSelectedMessages(false) }];
    if (allMyMessages) options.push({ text: "Delete for everyone", style: "destructive", onPress: () => deleteSelectedMessages(true) });
    Alert.alert("Delete Messages", `Delete ${selectedMessage.length} message(s)?`, options);
  }, [selectedMessage, messages, deleteSelectedMessages]);

  const handleSearch = useCallback((searchText) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    setSearch(searchText);
    if (!searchText || searchText.trim() === '') { 
      setIsSearching(false); 
      setSearchResults([]); 
      setCurrentSearchIndex(-1); 
      setMessages(allMessages.filter(msg => msg.chatId === chatIdRef.current)); 
      return; 
    }
    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(() => {
      const searchQuery = searchText.trim().toLowerCase();
      const results = allMessages.filter(msg => 
        msg.chatId === chatIdRef.current && 
        msg.type === 'text' && 
        msg.text && 
        msg.text.toLowerCase().includes(searchQuery)
      );
      const sortedResults = results.sort((a,b) => (b.timestamp || new Date(b.createdAt).getTime()) - (a.timestamp || new Date(a.createdAt).getTime()));
      setSearchResults(sortedResults);
      setMessages(sortedResults);
      setCurrentSearchIndex(sortedResults.length > 0 ? 0 : -1);
    }, 300);
  }, [allMessages]);

  const clearSearch = useCallback(() => { 
    setSearch(''); 
    setIsSearching(false); 
    setSearchResults([]); 
    setCurrentSearchIndex(-1); 
    setMessages(allMessages.filter(msg => msg.chatId === chatIdRef.current)); 
  }, [allMessages]);

  const goToNextResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIndex = (currentSearchIndex + 1) % searchResults.length;
    setCurrentSearchIndex(nextIndex);
    if (flatListRef.current && searchResults[nextIndex]) {
      const messageIndex = messages.findIndex(m => m.id === searchResults[nextIndex].id);
      if (messageIndex !== -1) flatListRef.current.scrollToIndex({ index: messageIndex, animated: true, viewPosition: 0.5 });
    }
  }, [searchResults, currentSearchIndex, messages]);

  const goToPreviousResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const prevIndex = currentSearchIndex === 0 ? searchResults.length - 1 : currentSearchIndex - 1;
    setCurrentSearchIndex(prevIndex);
    if (flatListRef.current && searchResults[prevIndex]) {
      const messageIndex = messages.findIndex(m => m.id === searchResults[prevIndex].id);
      if (messageIndex !== -1) flatListRef.current.scrollToIndex({ index: messageIndex, animated: true, viewPosition: 0.5 });
    }
  }, [searchResults, currentSearchIndex, messages]);

  const handleDownloadMedia = async (msg) => {
    try {
      if (!msg) return;

      if (msg?.isDeleted || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system') {
        return;
      }
  
      const messageType = String(msg?.type || msg?.mediaType || msg?.messageType || '').toLowerCase();
      if (!isMediaMessageType(messageType)) {
        return;
      }

      const resolvedIdentity = resolveMediaIdentity(msg);
      const messageId = String(resolvedIdentity?.mediaId || msg?.mediaId || msg?.serverMessageId || msg?.id || '');
      if (!messageId) {
        Alert.alert('Download failed', 'Media identifier missing for this message');
        return;
      }

      if (!resolvedIdentity?.mediaUrl && !msg?.mediaUrl && !msg?.previewUrl && !msg?.url) {
        Alert.alert('Download failed', 'Media URL missing for this message');
        return;
      }

      const effectiveChatId = normalizeId(msg?.chatId || chatIdRef.current);
      const eventKey = buildMediaStatusEventKey(effectiveChatId, messageId);

      setMediaDownloadStates((prev) => ({
        ...prev,
        [messageId]: {
          ...(prev[messageId] || { mediaId: messageId }),
          status: MEDIA_DOWNLOAD_STATUS.DOWNLOADING,
          progress: 0,
          error: null,
          updatedAt: Date.now(),
        },
      }));

      setDownloadProgress(prev => ({
        ...prev,
        [messageId]: 0
      }));

      const localUri = await mediaDownloadManager.download(
        {
          ...msg,
          mediaId: messageId,
          mediaUrl: resolvedIdentity?.mediaUrl || msg?.mediaUrl || msg?.previewUrl || msg?.url,
          mediaThumbnailUrl: resolvedIdentity?.mediaThumbnailUrl || msg?.mediaThumbnailUrl || msg?.thumbnailUrl || msg?.previewUrl,
          mediaMeta: resolvedIdentity?.mediaMeta || msg?.mediaMeta || msg?.payload?.mediaMeta || {},
          messageType: messageType,
          fileCategory: msg?.fileCategory || resolvedIdentity?.messageType || messageType,
        },
        {
          chatId: effectiveChatId || chatIdRef.current,
          filename: msg.text || msg.fileName || `${messageId}`,
          onProgress: (progressPct) => {
            const normalized = Math.max(0, Math.min(100, Number(progressPct || 0)));
            setDownloadProgress(prev => ({
              ...prev,
              [messageId]: normalized / 100,
            }));
          },
        }
      );

      if (!localUri) throw new Error("Download failed");

      await localStorageService.upsertMediaFile({
        mediaId: messageId,
        id: messageId,
        serverMessageId: msg.serverMessageId || msg.id || messageId,
        chatId: msg.chatId || chatIdRef.current,
        localPath: localUri,
        messageType: resolvedIdentity?.messageType || msg.type || msg.mediaType || 'file',
        serverUrl: resolvedIdentity?.mediaUrl || msg.mediaUrl || msg.previewUrl || null,
        thumbnailUrl: resolvedIdentity?.mediaThumbnailUrl || msg?.mediaThumbnailUrl || msg?.thumbnailUrl || msg.previewUrl || null,
        metadata: resolvedIdentity?.mediaMeta || msg?.mediaMeta || msg?.payload?.mediaMeta || {},
        downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
        downloadProgress: 100,
        downloadedAt: Date.now(),
        lastError: null,
        createdAtTs: Number(msg?.timestamp || Date.now()),
      });

      setDownloadedMedia((prev) => ({ ...prev, [messageId]: localUri }));
      setMediaDownloadStates((prev) => ({
        ...prev,
        [messageId]: {
          ...(prev[messageId] || { mediaId: messageId }),
          status: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
          progress: 100,
          localPath: localUri,
          error: null,
          updatedAt: Date.now(),
        },
      }));

      await applyMediaDownloadedStateLocally({
        messageId,
        chatId: effectiveChatId,
        isMediaDownloaded: true,
        localUri,
      });

      if (eventKey && !mediaStatusProcessedRef.current.has(eventKey)) {
        const deviceId = await getOrCreateDeviceId();
        await queueMediaStatusUpdate({
          messageId,
          chatId: effectiveChatId,
          deviceId,
          isMediaDownloaded: true,
        });
      }
  
      setDownloadProgress(prev => {
        const copy = { ...prev };
        delete copy[messageId];
        return copy;
      });

      return localUri;
  
    } catch (error) {
      console.log("❌ handleDownloadMedia error:", error);
      Alert.alert("Download failed", error?.message || "Unable to download media");

      const failedId = String(msg?.mediaId || msg?.serverMessageId || msg?.id || '');
      if (failedId) {
        setMediaDownloadStates((prev) => ({
          ...prev,
          [failedId]: {
            ...(prev[failedId] || { mediaId: failedId }),
            status: MEDIA_DOWNLOAD_STATUS.FAILED,
            progress: Number((prev[failedId]?.progress || 0)),
            localPath: prev[failedId]?.localPath || null,
            error: error?.message || 'download failed',
            updatedAt: Date.now(),
          },
        }));
      }
  
      setDownloadProgress(prev => {
        const copy = { ...prev };
        delete copy[String(msg?.mediaId || msg?.serverMessageId || msg?.id || '')];
        return copy;
      });

      return null;
    }
  };

  const cleanupTempMediaUri = useCallback(async (uri) => {
    try {
      if (!uri) return;
      const normalized = normalizeUri(uri);
      const cacheDir = normalizeUri(FileSystem.cacheDirectory || '');
      if (!normalized || !cacheDir || !normalized.startsWith(cacheDir)) return;
      const info = await FileSystem.getInfoAsync(normalized);
      if (info?.exists) {
        await FileSystem.deleteAsync(normalized, { idempotent: true });
      }
    } catch (error) {
      console.warn('cleanupTempMediaUri failed', error);
    }
  }, []);

  const sendMedia = useCallback(async (mediaObj, options = {}) => {
    if (!mediaObj || !mediaObj.file) return { success: false, error: 'invalid media payload' };

    const { file, type } = mediaObj;
    const normalizedType = type === 'document' ? 'file' : type;
    const tempId = options?.tempId || `temp_media_${Date.now()}_${Math.random()}`;
    const timestamp = options?.createdAt || new Date().toISOString();
    const localSourceUri = normalizeUri(file.uri);
    const shouldInsertLocal = !options?.skipLocalInsert;

    const localMsg = {
      id: tempId,
      tempId,
      type: normalizedType,
      mediaType: normalizedType,
      text: file.name || '',
      mediaUrl: '',
      mediaThumbnailUrl: localSourceUri,
      previewUrl: localSourceUri,
      localUri: localSourceUri,
      time: moment(timestamp).format("hh:mm A"),
      date: moment(timestamp).format("YYYY-MM-DD"),
      senderId: currentUserIdRef.current,
      senderType: 'self',
      receiverId: chatData.peerUser._id,
      status: 'sending',
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      payload: {
        chatId: chatIdRef.current,
        file: { ...file, uri: localSourceUri },
        tempId,
        isMediaDownloaded: true,
        uploadQueued: false,
      },
      downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
      isMediaDownloaded: true,
      synced: false,
      chatId: chatIdRef.current,
      useLocalForSender: true,
    };

    if (shouldInsertLocal) {
      setAllMessages((prev) => {
        const updated = [localMsg, ...prev];
        const uniqueMessages = deduplicateMessages(updated);
        saveMessagesToLocal(uniqueMessages);
        return uniqueMessages;
      });
    }

    if (!isConnected) {
      const queue = [...(queuedMediaUploadsRef.current || [])];
      const existingIndex = queue.findIndex((item) => item?.tempId === tempId);
      const queuedTask = {
        tempId,
        mediaObj: {
          ...mediaObj,
          file: { ...file, uri: localSourceUri },
        },
        createdAt: timestamp,
        retries: Number(queue[existingIndex]?.retries || 0),
      };
      if (existingIndex >= 0) queue[existingIndex] = queuedTask;
      else queue.push(queuedTask);
      queuedMediaUploadsRef.current = queue;
      await persistMediaUploadQueue(queue);

      setAllMessages((prev) => prev.map((m) => (
        m.tempId === tempId
          ? {
              ...m,
              status: 'failed',
              payload: {
                ...(m.payload || {}),
                uploadQueued: true,
              },
            }
          : m
      )));

      return { success: false, queued: true, error: 'offline queued' };
    }

    let uploadTick = 0;
    const uploadTimer = setInterval(() => {
      uploadTick += 1;
      setUploadProgress((prev) => {
        const current = Number(prev[tempId] || 0);
        if (current >= 0.92) return prev;
        const next = Math.min(0.92, current + 0.08);
        return { ...prev, [tempId]: next };
      });
      if (uploadTick > 40) clearInterval(uploadTimer);
    }, 250);

    setUploadProgress((prev) => ({ ...prev, [tempId]: 0.05 }));

    try {
      const uploadPromise = uploadMediaFile({
        file: { ...file, uri: localSourceUri },
        chatId: chatIdRef.current,
        dispatch,
        mediaUploadAction: mediaUpload,
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`upload timeout after ${MEDIA_UPLOAD_TIMEOUT_MS}ms`)), MEDIA_UPLOAD_TIMEOUT_MS);
      });

      const action = await Promise.race([uploadPromise, timeoutPromise]);
      const uploadedLocalUri = normalizeUri(action?.localUri || localSourceUri);
      const payloadData = action?.payload || action;
      const success = payloadData && (payloadData.status === true || payloadData.statusCode === 200 || payloadData.success === true);

      if (!success) {
        setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
        setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));
        return { success: false, error: payloadData?.message || 'upload failed' };
      }

      clearInterval(uploadTimer);
      setUploadProgress((prev) => ({ ...prev, [tempId]: 1 }));

      const uploadResponse = payloadData;
      const responseData = uploadResponse.data || uploadResponse;
      const deviceId = await getOrCreateDeviceId();
      const messagePayload = createMediaMessagePayload({
        uploadResponse: responseData,
        file,
        messageType: type,
        senderId: currentUserIdRef.current,
        senderDeviceId: deviceId,
        receiverId: chatData.peerUser._id,
        chatId: chatIdRef.current,
        messageId: responseData?.messageId,
      });

      const payloadValidation = validateMediaMessagePayload(messagePayload);
      if (!payloadValidation.isValid) {
        setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
        setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));
        return { success: false, error: `missing fields: ${payloadValidation.missing.join(',')}` };
      }

      const uploadedPreviewUrl = messagePayload.mediaUrl || '';
      const uploadedThumbnailUrl = messagePayload.mediaThumbnailUrl || '';
      const serverMessageId = messagePayload.messageId;
      const mediaId = messagePayload.mediaId;
      const normalizedCategory = messagePayload.messageType;
      const mediaMeta = messagePayload.mediaMeta;

      // For sender, always ensure mediaUrl/previewUrl are usable — fall back to localUri
      const resolvedMediaUrl = uploadedPreviewUrl || uploadedLocalUri;
      const resolvedPreviewUrl = uploadedThumbnailUrl || uploadedPreviewUrl || uploadedLocalUri;

      setAllMessages((prevMessages) => {
        const withoutTemp = prevMessages.filter((m) => m.tempId !== tempId && m.id !== tempId);
        const permanentMsg = {
          id: serverMessageId,
          serverMessageId,
          tempId,
          type: normalizedCategory,
          mediaType: normalizedCategory,
          text: file.name || '',
          mediaUrl: resolvedMediaUrl,
          mediaThumbnailUrl: resolvedPreviewUrl,
          previewUrl: resolvedPreviewUrl,
          localUri: uploadedLocalUri,
          serverMediaUrl: uploadedPreviewUrl,
          serverPreviewUrl: uploadedThumbnailUrl,
          time: moment(timestamp).format("hh:mm A"),
          date: moment(timestamp).format("YYYY-MM-DD"),
          senderId: currentUserIdRef.current,
          senderType: 'self',
          receiverId: chatData.peerUser._id,
          status: 'uploaded',
          createdAt: timestamp,
          timestamp: new Date(timestamp).getTime(),
          synced: true,
          payload: {
            ...messagePayload,
            file: { ...file, uri: uploadedLocalUri },
            isMediaDownloaded: true,
            uploadQueued: false,
          },
          mediaMeta,
          downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
          isMediaDownloaded: true,
          chatId: chatIdRef.current,
          useLocalForSender: true,
          mediaId,
        };

        const updated = [permanentMsg, ...withoutTemp];
        const uniqueMessages = deduplicateMessages(updated);
        const sorted = uniqueMessages.sort((a, b) => b.timestamp - a.timestamp);
        saveMessagesToLocal(sorted);
        return sorted;
      });

      await sendMessageViaSocket({ ...messagePayload, tempId }, tempId).catch((err) => {
        console.warn('media socket ack failed', err?.message || err);
      });

      const queue = [...(queuedMediaUploadsRef.current || [])].filter((item) => item?.tempId !== tempId);
      queuedMediaUploadsRef.current = queue;
      await persistMediaUploadQueue(queue);
      return { success: true, tempId, messageId: serverMessageId };
    } catch (err) {
      const message = String(err?.message || err || 'upload failed');
      const isNetworkFailure = /network request failed|timeout|aborted|socket not connected/i.test(message);

      console.error('❌ [SEND MEDIA] Error:', {
        message,
        isConnected,
        networkType,
        fileUri: localSourceUri,
        fileType: file?.type,
        fileName: file?.name,
      });

      setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
      setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));

      if (isNetworkFailure) {
        const queue = [...(queuedMediaUploadsRef.current || [])];
        const existingIndex = queue.findIndex((item) => item?.tempId === tempId);
        const nextRetries = Number((existingIndex >= 0 ? queue[existingIndex]?.retries : 0) || 0);
        const task = {
          tempId,
          mediaObj: {
            ...mediaObj,
            file: { ...file, uri: localSourceUri },
          },
          createdAt: timestamp,
          retries: nextRetries,
        };
        if (existingIndex >= 0) queue[existingIndex] = task;
        else queue.push(task);
        queuedMediaUploadsRef.current = queue;
        await persistMediaUploadQueue(queue);
      }

      return { success: false, error: message };
    } finally {
      clearInterval(uploadTimer);
      if (!options?.fromQueue) {
        setPendingMedia(null);
      }
      setDownloadProgress((prev) => {
        const p = { ...prev };
        delete p[tempId];
        return p;
      });
      setTimeout(() => {
        setUploadProgress((prev) => {
          const next = { ...prev };
          delete next[tempId];
          return next;
        });
      }, 900);

      // Safety net: if the message is still stuck at 'sending'/'uploaded' after 5s,
      // check if it has a serverMessageId and promote it to 'sent'
      setTimeout(() => {
        setAllMessages((prev) => {
          let changed = false;
          const updated = prev.map((m) => {
            if (m.tempId !== tempId) return m;
            if ((m.status === 'sending' || m.status === 'uploaded') && m.serverMessageId) {
              changed = true;
              return { ...m, status: 'sent', synced: true };
            }
            return m;
          });
          if (changed) {
            saveMessagesToLocal(updated);
            return updated;
          }
          return prev;
        });
      }, 5000);
    }
  }, [
    isConnected,
    networkType,
    dispatch,
    chatData.peerUser,
    deduplicateMessages,
    saveMessagesToLocal,
    getOrCreateDeviceId,
    createMediaMessagePayload,
    validateMediaMessagePayload,
    sendMessageViaSocket,
    persistMediaUploadQueue,
  ]);

  const flushQueuedMediaUploads = useCallback(async () => {
    if (mediaUploadQueueInFlightRef.current) return;
    if (!isConnected) return;

    const queue = [...(queuedMediaUploadsRef.current || [])];
    if (queue.length === 0) return;

    mediaUploadQueueInFlightRef.current = true;
    try {
      let working = [...queue];
      for (const item of queue) {
        const retries = Number(item?.retries || 0);
        if (retries >= MEDIA_UPLOAD_MAX_RETRIES) {
          working = working.filter((q) => q?.tempId !== item?.tempId);
          continue;
        }

        const result = await sendMedia(item?.mediaObj, {
          tempId: item?.tempId,
          skipLocalInsert: true,
          fromQueue: true,
          createdAt: item?.createdAt,
        });

        if (result?.success) {
          working = working.filter((q) => q?.tempId !== item?.tempId);
        } else {
          working = working.map((q) => (
            q?.tempId === item?.tempId
              ? { ...q, retries: retries + 1 }
              : q
          ));
        }
      }

      queuedMediaUploadsRef.current = working;
      await persistMediaUploadQueue(working);
    } catch (error) {
      console.error('flushQueuedMediaUploads error', error);
    } finally {
      mediaUploadQueueInFlightRef.current = false;
    }
  }, [isConnected, persistMediaUploadQueue, sendMedia]);

  flushQueuedMediaUploadsRef.current = flushQueuedMediaUploads;

  const resendMessage = useCallback(async (msg) => {
    if (!msg) return;
    if (msg.mediaUrl) {
      const normalizedCategory = normalizeOutboundMessageType(
        msg?.mediaType || msg?.type || msg?.fileCategory || 'file'
      );

      const deviceId = await getOrCreateDeviceId();

      const resolvedThumb =
        msg?.mediaThumbnailUrl ||
        msg?.thumbnailUrl ||
        msg?.payload?.mediaThumbnailUrl ||
        msg?.payload?.thumbnailUrl ||
        msg?.payload?.file?.mediaThumbnailUrl ||
        msg?.payload?.file?.thumbnailUrl ||
        msg?.payload?.file?.previewUrl ||
        msg?.previewUrl ||
        msg?.mediaUrl;
      const resolvedMediaUrl = msg?.mediaUrl || msg?.previewUrl || msg?.payload?.mediaUrl || '';
      const existingMeta = msg?.mediaMeta || msg?.payload?.mediaMeta || {};
      const messagePayload = {
        chatId: chatIdRef.current,
        chatType: 'private',
        messageId: String(msg?.serverMessageId || msg?.id || msg?.tempId || generateClientMessageId()),
        senderId: currentUserIdRef.current,
        senderDeviceId: deviceId,
        receiverId: chatData.peerUser._id,
        messageType: normalizedCategory,
        mediaId: String(msg?.mediaId || existingMeta?.mediaId || msg?.serverMessageId || msg?.id || ''),
        mediaUrl: resolvedMediaUrl,
        mediaThumbnailUrl: resolvedThumb || resolvedMediaUrl,
        mediaMeta: {
          fileName: existingMeta?.fileName || msg?.text || extractFileName(resolvedMediaUrl),
          fileSize: existingMeta?.fileSize || existingMeta?.sizeAfter || null,
          mimeType: existingMeta?.mimeType || msg?.payload?.file?.type || `application/${normalizedCategory}`,
          width: existingMeta?.width || null,
          height: existingMeta?.height || null,
        },
        status: 'sent',
        text: msg.text || '',
        createdAt: new Date().toISOString(),
      };

      const payloadValidation = validateMediaMessagePayload(messagePayload);
      if (!payloadValidation.isValid) {
        console.warn('❌ resendMessage: missing required media fields', payloadValidation.missing);
        updateMessageStatus(msg.tempId || msg.id, 'failed');
        return;
      }

      console.log("MESSAGE PAYLOAD", messagePayload);
      const payload = {
        ...messagePayload,
        fileCategory: normalizedCategory,
        previewUrl: messagePayload.mediaThumbnailUrl,
        thumbnailUrl: messagePayload.mediaThumbnailUrl,
        tempId: msg.tempId || `temp_retry_${Date.now()}`,
      };

      console.log('🔄 Resending media message with payload: *******', payload);
      try {
        await sendMessageViaSocket(payload, msg.tempId || payload.tempId);
      } catch (err) {
        console.warn('resendMessage failed', err);
      }
    } else if (msg.payload && msg.payload.file) {
      await sendMedia({ file: msg.payload.file, type: msg.type });
    } else {
      await sendMessageViaSocket({
        chatId: chatIdRef.current,
        senderId: currentUserIdRef.current,
        receiverId: chatData.peerUser._id,
        messageType: 'text',
        text: msg.text || '',
        tempId: msg.tempId || `temp_retry_${Date.now()}`,
        createdAt: new Date().toISOString(),
      }, msg.tempId || `temp_retry_${Date.now()}`);
    }
  }, [
    sendMessageViaSocket,
    sendMedia,
    chatData.peerUser,
    getOrCreateDeviceId,
    normalizeOutboundMessageType,
    validateMediaMessagePayload,
    updateMessageStatus,
  ]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setIsManualReloading(false);
    reconnectAttempts.current = 0;
    loadMoreInFlightRef.current = false;
    fetchOlderCursorRef.current = null;
    await checkAndReconnectSocket();
    await syncMessagesToAPI();
    setHasLoadedFromAPI(false);
    setCurrentPage(1);
    setHasMoreMessages(true);
    fetchAndSyncMessagesViaSocket(chatIdRef.current, { limit: SOCKET_FETCH_LIMIT, force: true });
    dispatch(chatMessage({ chatId: chatIdRef.current, search: '', page: 1, limit: 50 }));
    setTimeout(() => setIsRefreshing(false), 1000);
  }, [dispatch, checkAndReconnectSocket, fetchAndSyncMessagesViaSocket]);

  const manualReloadMessages = useCallback(async () => {
    setIsManualReloading(true);
    setIsRefreshing(true);
    try {
      isHardReloadingRef.current = true;
      await checkAndReconnectSocket();
      forceReloadPendingRef.current = true;
      fetchAndSyncMessagesViaSocket(chatIdRef.current, {
        limit: SOCKET_FETCH_LIMIT,
        force: true,
      });
    } finally {
      setTimeout(() => {
        setIsRefreshing(false);
        setIsManualReloading(false);
      }, 800);

      setTimeout(() => {
        if (isHardReloadingRef.current) {
          isHardReloadingRef.current = false;
          forceReloadPendingRef.current = false;
        }
      }, 10000);
    }
  }, [checkAndReconnectSocket, fetchAndSyncMessagesViaSocket]);

  const refreshMessagesFromLocal = useCallback(async () => {
    if (!chatIdRef.current) return;

    setIsRefreshing(true);
    try {
      await loadDeletedTombstones(chatIdRef.current);

      setAllMessages((prevMessages) => (
        prevMessages.filter((msg) => msg.chatId !== chatIdRef.current)
      ));

      await loadMessagesFromLocal(chatIdRef.current);
    } catch (error) {
      console.error('refreshMessagesFromLocal error', error);
    } finally {
      setTimeout(() => {
        setIsRefreshing(false);
      }, 500);
    }
  }, [loadDeletedTombstones]);

  const toggleChatMute = useCallback((durationMs = null) => {
    const socket = socketRef.current || getSocket();
    const now = Date.now();
    const nextMuteUntil = durationMs ? now + durationMs : null;

    const currentlyMuted = Boolean(isChatMuted) && (!muteUntil || muteUntil > now);
    if (currentlyMuted && durationMs === null) {
      if (socket && isSocketConnected() && chatIdRef.current) {
        socket.emit('chat:unmute', { chatId: chatIdRef.current });
      }
      setIsChatMuted(false);
      setMuteUntil(null);
      return;
    }

    if (socket && isSocketConnected() && chatIdRef.current) {
      socket.emit('chat:mute', { chatId: chatIdRef.current, muteUntil: nextMuteUntil });
    }
    setIsChatMuted(true);
    setMuteUntil(nextMuteUntil);
  }, [isChatMuted, muteUntil]);

  const loadMoreMessages = useCallback(() => {
    if (isLoadingMore || loadMoreInFlightRef.current) return;
    if (!hasMoreMessages) return;

    const nextPage = currentPage + 1;
    const oldest = messages.length > 0
      ? messages.reduce((acc, msg) => {
          const ts = Number(msg?.timestamp || 0);
          if (!acc || ts < acc) return ts;
          return acc;
        }, 0)
      : null;

    if (!oldest || fetchOlderCursorRef.current === oldest) {
      return;
    }

    loadMoreInFlightRef.current = true;
    fetchOlderCursorRef.current = oldest;
    setIsLoadingMore(true);
    setCurrentPage(nextPage);

    fetchAndSyncMessagesViaSocket(chatIdRef.current, {
      before: oldest || undefined,
      limit: SOCKET_FETCH_LIMIT,
    });

    dispatch(chatMessage({ chatId: chatIdRef.current, search: '', page: nextPage, limit: 50 }));
  }, [isLoadingMore, hasMoreMessages, currentPage, dispatch, messages, fetchAndSyncMessagesViaSocket]);

  /* ========== FIXED: Render status helper ========== */
  const renderStatusText = useCallback(() => {
    if (isPeerTyping) {
      return 'typing...';
    }
    if (customStatus) {
      return customStatus;
    }
    if (userStatus === PRESENCE_STATUS.ONLINE) {
      return 'online';
    }
    if (userStatus === PRESENCE_STATUS.AWAY) {
      return 'away';
    }
    if (userStatus === PRESENCE_STATUS.BUSY) {
      return 'busy';
    }
    if (lastSeen) {
      return `last seen ${moment(lastSeen).fromNow()}`;
    }
    return 'offline';
  }, [isPeerTyping, userStatus, lastSeen, customStatus]);

  const openMediaOptions = () => setShowMediaOptions(true);
  const closeMediaOptions = () => setShowMediaOptions(false);
  const closeMediaViewer = useCallback(() => setMediaViewer({ visible: false, uri: null, type: null }), []);
  
  const handlePickMedia = useCallback(async (type) => {
    try {
      closeMediaOptions();
      const file = await pickMedia(type);
      if (!file) return;
      setPendingMedia({ file, type });
    } catch (err) {
      console.error("handlePickMedia error", err);
    }
  }, [pickMedia]);

  useEffect(() => {
    if (!Array.isArray(allMessages) || allMessages.length < 2) return;

    const deduped = deduplicateMessages(allMessages);
    if (deduped.length === allMessages.length) return;

    const sorted = deduped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    setAllMessages(sorted);
    saveMessagesToLocal(sorted);
  }, [allMessages, deduplicateMessages, saveMessagesToLocal]);

  useEffect(() => {
    console.log("📱 ChatScreen received params:", {
      chatId: route.params?.chatId,
      user: route.params?.user,
      isNewContact: route.params?.isNewContact,
      hasExistingChat: route.params?.hasExistingChat,
      isNewChat: route.params?.isNewChat
    });
  }, [route.params]);

  return {
    fadeAnimRef, flatListRef,
    chatData, chatId, currentUserId, getUserColor,
    messages, allMessages, isLoadingInitial, isLoadingFromLocal, isRefreshing, isManualReloading, isSearching,
    // FIXED: Export the correct typing state
    isPeerTyping, // This is what the UI should use for "typing..." indicator
    isLocalTyping, // Optional: if UI needs to know local typing state
    userStatus, customStatus, presenceDetails, manualPresencePending, renderStatusText,
    setManualPresence, clearManualPresence,
    search, handleSearch, clearSearch, goToNextResult, goToPreviousResult, searchResults, currentSearchIndex,
    selectedMessage, handleToggleSelectMessages, handleDeleteSelected,
    text, setText, handleTextChange, handleSendText,
    sendLocationMessage, sendContactMessage,
    pendingMedia, setPendingMedia, sendMedia, handlePickMedia, showMediaOptions, openMediaOptions, closeMediaOptions,
    mediaViewer, closeMediaViewer, handleDownloadMedia, downloadedMedia, downloadProgress, uploadProgress, mediaDownloadStates,
    markMediaRemovedLocally,
    retryMediaStatusUpdate, retryAllFailedMediaStatusUpdates,
    onRefresh, loadMoreMessages, isLoadingMore, hasMoreMessages,
    manualReloadMessages,
    refreshMessagesFromLocal,
    isChatMuted, muteUntil, toggleChatMute,
    clearChatForMe,
    clearChatForEveryone,
    markVisibleIncomingAsRead,
    setMessages, saveMessagesToLocal, resendMessage,
    editingMessage, startEditMessage, cancelEditMessage, submitEditMessage,
  };
}