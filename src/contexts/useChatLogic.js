import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Keyboard, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import moment from "moment";
import { useDispatch, useSelector } from "react-redux";
import { chatMessage, chatListData, mediaUpload, downloadMedia } from "../Redux/Reducer/Chat/Chat.reducer";
import { getSocket, isSocketConnected, reconnectSocket } from "../Redux/Services/Socket/socket";
import { useNetwork } from "../contexts/NetworkContext";
import { useImage } from "../contexts/ImageProvider";
import { useFocusEffect } from "@react-navigation/native";
import { normalizePresencePayload, normalizeStatus, PRESENCE_STATUS } from "../utils/presence";
import { useRealtimeChat } from "./RealtimeChatContext";

/* mediaService: copyToAppFolder, saveFileToMediaLibrary, normalizeUri, uploadMediaFile, downloadAndOpenMedia */
import {
  copyToAppFolder,
  saveFileToMediaLibrary,
  normalizeUri,
  uploadMediaFile,
  downloadAndOpenMedia,
  SENT_DIR,
  APP_FOLDER,
  downloadRemoteToReceived,
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
const DELETED_TOMBSTONES_PREFIX = "chat_deleted_tombstones_";
const READ_MARK_DELAY = 800;
const SOCKET_FETCH_LIMIT = 50;

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

const computeSenderType = (senderId, currentUserId) => (
  sameId(senderId, currentUserId) ? 'self' : 'other'
);

const buildDeletePlaceholderText = (isDeletedBySelf) => (
  isDeletedBySelf ? '🗑 You deleted this message' : '🗑 This message was deleted'
);

export default function useChatLogic({ navigation, route }) {
  const dispatch = useDispatch();
  const { isConnected, networkType } = useNetwork();
  const { pickMedia } = useImage();
  const { setActiveChat, markChatRead, onLocalOutgoingMessage, updateLocalLastMessagePreview } = useRealtimeChat();
  const chatMessagesData = useSelector(state => state.chat?.chatMessagesData || state.chat?.data || state.chat);

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
  const [isChatMuted, setIsChatMuted] = useState(Boolean(item?.isMuted));
  const [muteUntil, setMuteUntil] = useState(item?.muteUntil || null);

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

      setActiveChat(null);
      
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
      setActiveChat(generatedChatId);
      markChatRead(generatedChatId);
      lastInitializedChatRef.current = generatedChatId;

      setMessages([]);
      setAllMessages([]);

      await loadQueuedManualPresence();
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
        markUserOnline("chat-init");
        startHeartbeat();
        resetIdleTimer();
        flushQueuedManualPresence();
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
      const localKey = `chat_messages_${chatIdParam}`;
      const savedMessages = await AsyncStorage.getItem(localKey);
      console.log("savedMessages from local - -", savedMessages)
  
      if (!savedMessages) return 0;
  
      const parsed = JSON.parse(savedMessages);
      
      const processed = parsed.map(msg => {
        const normalizedSenderId = normalizeId(msg.senderId);
        const normalizedReceiverId = normalizeId(msg.receiverId);
        const normalizedCurrentUser = normalizeId(currentUserIdRef.current);
        const normalizedPeer = normalizeId(chatData?.peerUser?._id);

        let base = {
          ...msg,
          senderId: normalizedSenderId,
          senderType: msg.senderType || computeSenderType(normalizedSenderId, normalizedCurrentUser),
          receiverId: normalizedReceiverId,
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
    if (s === 'sending') return 'sending';
    if (s === 'failed') return 'failed';
    return undefined;
  }, []);

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
    const serverId = apiMsg?._id || apiMsg?.messageId || apiMsg?.id;
    const createdAtRaw = apiMsg?.createdAt || apiMsg?.timestamp || new Date().toISOString();
    const createdAt = typeof createdAtRaw === 'number' ? new Date(createdAtRaw).toISOString() : createdAtRaw;

    const normalizedSenderId = normalizeId(apiMsg?.senderId);
    const normalizedReceiverId = normalizeId(apiMsg?.receiverId);
    const normalizedCurrentUser = normalizeId(currentUserIdRef.current);
    const normalizedServerId = normalizeId(serverId);
    const tombstone = normalizedServerId ? deletedTombstonesRef.current?.[normalizedServerId] : null;
    const resolvedDeletedFor = apiMsg?.deletedFor ?? apiMsg?.deleteFor ?? apiMsg?.delete_type ?? null;
    const resolvedIsDeleted = apiMsg?.isDeleted === true || resolvedDeletedFor === 'everyone' || Boolean(tombstone);
    const resolvedDeletedBy = normalizeId(apiMsg?.deletedBy) || normalizeId(tombstone?.deletedBy) || null;
    const isDeletedBySelf = sameId(resolvedDeletedBy, normalizedCurrentUser);
    const resolvedPlaceholderText = apiMsg?.placeholderText || tombstone?.placeholderText || buildDeletePlaceholderText(isDeletedBySelf);

    console.log({
        id: serverId,
        serverMessageId: serverId,
        tempId: serverId,
        type: apiMsg?.messageType || apiMsg?.fileCategory || apiMsg?.type || "text",
        mediaType: apiMsg?.fileCategory || null,
        text: apiMsg?.text || apiMsg?.content || "",
        time: moment(createdAt).format("hh:mm A"),
        date: moment(createdAt).format("YYYY-MM-DD"),
        senderId: normalizedSenderId,
        senderType: computeSenderType(normalizedSenderId, normalizedCurrentUser),
        receiverId: normalizedReceiverId,
        status: sameId(normalizedSenderId, normalizedCurrentUser)
          ? (normalizeMessageStatus(apiMsg?.status) || "sent")
          : normalizeMessageStatus(apiMsg?.status),
        mediaUrl: apiMsg?.mediaUrl || apiMsg?.url || null,
        previewUrl: apiMsg?.previewUrl || apiMsg?.thumbnailUrl || apiMsg?.mediaUrl || apiMsg?.url || null,
        createdAt,
        timestamp: new Date(createdAt).getTime(),
        synced: true,
        chatId: apiMsg?.chatId || chatIdRef.current,
        isDeleted: resolvedIsDeleted,
        deletedFor: resolvedDeletedFor,
        deletedBy: resolvedDeletedBy,
        placeholderText: resolvedIsDeleted ? resolvedPlaceholderText : null,
    })

    return {
      id: serverId,
      serverMessageId: serverId,
      tempId: serverId,
      type: apiMsg?.messageType || apiMsg?.fileCategory || apiMsg?.type || "text",
      mediaType: apiMsg?.fileCategory || null,
      text: apiMsg?.text || apiMsg?.content || "",
      time: moment(createdAt).format("hh:mm A"),
      date: moment(createdAt).format("YYYY-MM-DD"),
      senderId: normalizedSenderId,
      senderType: computeSenderType(normalizedSenderId, normalizedCurrentUser),
      receiverId: normalizedReceiverId,
      status: sameId(normalizedSenderId, normalizedCurrentUser)
        ? (normalizeMessageStatus(apiMsg?.status) || "sent")
        : normalizeMessageStatus(apiMsg?.status),
      mediaUrl: apiMsg?.mediaUrl || apiMsg?.url || null,
      previewUrl: apiMsg?.previewUrl || apiMsg?.thumbnailUrl || apiMsg?.mediaUrl || apiMsg?.url || null,
      createdAt,
      timestamp: new Date(createdAt).getTime(),
      synced: true,
      chatId: apiMsg?.chatId || chatIdRef.current,
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
            localUri: keepDeletedPlaceholder ? null : (formattedMessage.localUri || existing?.localUri || null),
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
  }, [deduplicateMessages, normalizeIncomingMessage, saveMessagesToLocal]);

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
        const isDeletedMessage = Boolean(msg?.isDeleted) || msg?.deletedFor === 'everyone' || msg?.type === 'system';
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
    if (socket && isSocketConnected() && chatIdRef.current) {
      socket.emit('message:read:bulk', {
        chatId: chatIdRef.current,
        messageIds,
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
      markChatRead(chatIdRef.current);
    }
  }, [markChatRead, saveMessagesToLocal]);

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
      if (socket && isSocketConnected() && chatIdRef.current && unreadVisibleIds.length === 1) {
        socket.emit('message:read', {
          messageId: unreadVisibleIds[0],
          chatId: chatIdRef.current,
          timestamp: Date.now(),
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

    messagesArray.forEach(msg => {
      const key =
        msg.serverMessageId ||
        msg.id ||
        msg.tempId ||
        `${msg.senderId}_${msg.timestamp}`;

      if (!key) return;

      if (uniqueMap.has(key)) {
        const existing = uniqueMap.get(key);

        if (msg.serverMessageId && !existing.serverMessageId) {
          uniqueMap.set(key, msg);
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
      const localKey = `chat_messages_${chatIdRef.current}`;
      
      const uniqueMessages = deduplicateMessages(msgs);
      const messagesToSave = uniqueMessages.slice(0, MAX_LOCAL_SAVE);
      
      console.log('💾 [SAVE TO LOCAL] Saving', messagesToSave.length, 'messages');
      
      const cleanMessages = messagesToSave.map(msg => ({
        ...msg,
        senderType: msg.senderType || computeSenderType(msg.senderId, currentUserIdRef.current),
        localUri: msg.localUri || null,
      }));
      
      await AsyncStorage.setItem(localKey, JSON.stringify(cleanMessages));
      console.log('💾 [SAVE TO LOCAL] Save complete');
    } catch (err) {
      console.error("Failed to save to local storage:", err);
    }
  }, [deduplicateMessages]);

  const applyDeleteToLocalStorage = useCallback(async (messageId, isDeletedForEveryone, options = {}) => {
    try {
      if (!chatIdRef.current || !messageId) return;
      const localKey = `chat_messages_${chatIdRef.current}`;
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

      const localKey = `chat_messages_${normalizedChatId}`;
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

    const latestVisible = sameChatMessages.find((msg) => !(msg?.isDeleted || msg?.deletedFor === 'everyone' || msg?.type === 'system'));

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

    const latestTs = allMessages.reduce((acc, msg) => {
      const ts = Number(msg?.timestamp || new Date(msg?.createdAt || 0).getTime() || 0);
      return Math.max(acc, Number.isNaN(ts) ? 0 : ts);
    }, 0);

    const syncFromTs = Math.max(lastMessageSyncAtRef.current || 0, latestTs || 0);

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
        fromTimestamp: syncFromTs || 0,
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
            localUri: keepDeletedPlaceholder ? null : (formattedMessage.localUri || existing?.localUri || null),
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

  }, [deduplicateMessages, saveMessagesToLocal, normalizeIncomingMessage]);

  const syncMessagesToAPI = async () => {
    try {
      if (!chatIdRef.current) return;
      const localKey = `chat_messages_${chatIdRef.current}`;
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
    socket.off('message:sent:ack');
    socket.off('message:sent');
    socket.off('message:new');
    socket.off('message:received');
    socket.off('message:delivered');
    socket.off('message:read');
    socket.off('message:read:bulk');
    socket.off('message:status');
    socket.off('message:fetch:response');
    socket.off('message:sync:response');
    socket.off('message:deleted');
    // socket.off('message:delete:sync');
    socket.off('message:delete:everyone');
    socket.off('message:delete:me');
    socket.off('message:delete:response');
    socket.off('message:delete:everyone:response');
    socket.off('message:delete:me:response');
    socket.off('presence:update');
    socket.off('presence:get:response');
    socket.off('presence:status:response');
    socket.off('presence:manual:updated');
    socket.off('user:online');
    socket.off('user:offline');
    socket.off('typing:start');
    socket.off('typing:stop');
    socket.off('typing:recording');
    socket.off('typing:recording:update');
    socket.off('disconnect');
    socket.off('connect');
  }, []);

  // FIXED: Setup socket listeners with proper typing handlers
  const setupSocketListeners = useCallback((socket, currentChatId) => {
    removeSocketListeners(socket);

    socket.on('message:sent:ack', (data) => {
      const messageId = data.messageId || data._id || data.data?.messageId || data.data?._id;
      const tempId = data.tempId || data.data?.tempId;
      if (data.persistenceConfirmed === true || data.status === true || messageId) {
        updateMessageStatus(tempId, 'sent', { messageId, ...data });
      }
    });

    socket.on('message:sent', (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id;
      const tempId = source?.tempId;
      if (tempId || messageId) {
        updateMessageStatus(tempId || messageId, 'sent', { messageId, ...source });
      }
    });

    socket.on('message:new', (data) => {
      const chatInPayload = data.chatId || data.chat || data.roomId;
      if (chatInPayload && chatInPayload !== currentChatId) return;
      handleReceivedMessage(data);
    });

    socket.on('message:received', (data) => { handleReceivedMessage(data); });
    socket.on('message:delivered', (data) => { if (data.messageId) updateMessageStatus(data.messageId, 'delivered', data); });
    socket.on('message:read', (data) => {
      const source = data?.data || data;
      if (source?.messageId) {
        updateMessageStatus(source.messageId, 'seen', source);
        return;
      }

      const sourceChatId = source?.chatId || source?.chat;
      if (sourceChatId && sourceChatId === currentChatId) {
        setAllMessages(prev => {
          const updated = prev.map(msg => {
            const isMine = msg.senderId === currentUserIdRef.current;
            if (!isMine) return msg;
            if (msg.status === 'sent' || msg.status === 'delivered') {
              return { ...msg, status: 'seen' };
            }
            return msg;
          });
          saveMessagesToLocal(updated);
          return updated;
        });
      }
    });
    socket.on('message:read:bulk', (data) => {
      const source = data?.data || data;
      const messageIds = Array.isArray(source?.messageIds) ? source.messageIds : [];
      if (messageIds.length > 0) {
        setAllMessages(prev => {
          const updated = prev.map(msg => {
            const id = msg.serverMessageId || msg.id || msg.tempId;
            if (!messageIds.includes(id)) return msg;
            return { ...msg, status: 'seen' };
          });
          saveMessagesToLocal(updated);
          return updated;
        });
      }
    });

    socket.on('message:status', (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      const status = source?.status;
      if (!messageId || !status) return;
      updateMessageStatus(messageId, status, source);
    });

    socket.on('message:fetch:response', (data) => {
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
    });

    socket.on('message:sync:response', (data) => {
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
    });

    socket.on('message:delete:everyone', (data) => {
      console.log('🧪 [B:SOCKET:DELETE:RECV]', {
        event: 'message:delete:everyone',
        raw: data,
      });
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatId = source?.chatId || source?.chat || source?.roomId;
      if (!sameId(chatId, currentChatId)) return;
      handleDeleteMessage(messageId, true, { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    });

    socket.on('message:delete:me', (data) => {
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
    });

    socket.on('message:deleted', (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatIdInPayload = source?.chatId || source?.chat || source?.roomId;
      const deleteFor = source?.deleteFor || source?.delete_type || (source?.isDeletedForEveryone ? 'everyone' : 'me') || 'everyone';
      if (!messageId || (chatIdInPayload && !sameId(chatIdInPayload, currentChatId))) return;
      handleDeleteMessage(messageId, deleteFor === 'everyone', { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    });

    socket.on('message:delete:sync', (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatIdInPayload = source?.chatId || source?.chat || source?.roomId;
      if (!messageId || (chatIdInPayload && !sameId(chatIdInPayload, currentChatId))) return;
      handleDeleteMessage(messageId, false, { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    });

    socket.on('message:delete:everyone:response', async (data) => {
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
    });

    socket.on('message:delete:response', async (data) => {
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
    });
    socket.on('message:delete:me:response', (data) => { if (data.status === false) Alert.alert("Error", data.message || "Failed to delete message"); });

    socket.on('presence:update', (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    });

    socket.on('presence:get:response', (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    });

    socket.on('presence:status:response', (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    });

    socket.on('presence:manual:updated', (data) => {
      const sourceUserId = data.userId || data?.data?.userId;
      if (sourceUserId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    });

    socket.on('user:online', (data) => {
      console.log("user:online", data);
      if (data.userId === chatData.peerUser._id) { 
        setUserStatus(PRESENCE_STATUS.ONLINE);
        setLastSeen(null); 
      }
    });

    socket.on('user:offline', (data) => {
      console.log("user:offline", data);
      if (data.userId === chatData.peerUser._id) { 
        setUserStatus(PRESENCE_STATUS.OFFLINE);
        setLastSeen(data.lastSeen || new Date().toISOString()); 
      }
    });

    // FIXED: Typing event handlers
    socket.on('typing:start', (data) => {
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
    });

    socket.on('typing:stop', (data) => {
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
    });

    // Handle recording as typing
    socket.on('typing:recording', (data) => {
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
    });

    socket.on('typing:recording:update', (data) => {
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
    });

    socket.on('disconnect', () => {
      setUserStatus(PRESENCE_STATUS.OFFLINE);
      setIsPeerTyping(false); // Reset typing state on disconnect
      stopHeartbeat();
      setTimeout(() => { if (isComponentMounted.current) checkAndReconnectSocket(); }, 2000);
    });

    socket.on('connect', () => {
      reconnectAttempts.current = 0;
      requestUserPresence();
      flushQueuedManualPresence();
      startHeartbeat();
      markUserOnline("socket-connect");
      socket.emit('chat:join', { chatId: currentChatId, userId: currentUserIdRef.current });
      socket.emit('user:status', { userId: currentUserIdRef.current, status: 'online', chatId: currentChatId });
      if (!initialLoadDoneRef.current) {
        fetchAndSyncMessagesViaSocket(currentChatId, { limit: SOCKET_FETCH_LIMIT });
      } else {
        fetchAndSyncMessagesViaSocket(currentChatId, { limit: SOCKET_FETCH_LIMIT, syncOnly: true });
      }
    });
  }, [
    chatData.peerUser,
    removeSocketListeners,
    requestUserPresence,
    checkAndReconnectSocket,
    applyPresenceState,
    flushQueuedManualPresence,
    startHeartbeat,
    stopHeartbeat,
    markUserOnline,
    updateMessageStatus,
    mergeMessagesIntoState,
    replaceMessagesForChat,
    applyDeleteEveryoneToChatStorage,
    saveMessagesToLocal,
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

        const updatedMsg = { ...msg, status: normalizedStatus };
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

        return updatedMsg;
      });

      const uniqueMessages = removeDuplicateMessages(updated);
      saveMessagesToLocal(uniqueMessages);
      return uniqueMessages;
    });
  }, [removeDuplicateMessages, saveMessagesToLocal, normalizeMessageStatus]);

  const sendMessageViaSocket = useCallback((payload, tempId) => {
    return new Promise(async (resolve, reject) => {
      try {
        const socket = socketRef.current || getSocket();
        if (!socket || !isSocketConnected()) {
          console.warn("⚠️ sendMessageViaSocket: socket not connected");
          updateMessageStatus(tempId, 'failed');
          return reject(new Error('socket not connected'));
        }

        updateMessageStatus(tempId, 'sending');

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
    if (!isSocketConnected()) {
      Alert.alert("Connection Error", "Unable to send message. Reconnecting...", [{ text: "OK" }]);
      await checkAndReconnectSocket();
      return;
    }
    
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
        return;
      }

      socket.emit('message:send', payload, (response) => {
        if (response && response.status === true) {
          const serverMessageId = response.data?.messageId || response.data?._id || response.messageId || response._id;
          updateMessageStatus(tempId, 'sent', { messageId: serverMessageId, ...response.data });
        } else {
          updateMessageStatus(tempId, 'failed');
        }
      });
    } catch (error) {
      console.error("❌ Send message failed:", error);
      updateMessageStatus(tempId, 'failed');
    }

    dispatch(chatListData(''));
  }, [text, chatData.peerUser, sendTypingStatus, removeDuplicateMessages, saveMessagesToLocal, updateMessageStatus, dispatch, checkAndReconnectSocket, isLocalTyping, markUserOnline, onLocalOutgoingMessage]);

  /* ========== FIXED: Text input change handler with proper typing ========== */
  const handleTextChange = useCallback((value) => {
    setText(value);
    resetIdleTimer();
    emitPresenceActivity({ reason: "typing" });
    
    const socket = socketRef.current || getSocket();
    const isSocketOk = socket && isSocketConnected();
    
    console.log('📝 [TYPING] Text changed:', { 
      length: value.length, 
      socketConnected: isSocketOk,
      currentTyping: isLocalTyping 
    });

    if (value.length > 0) {
      // If we weren't typing before, send typing:start
      if (!isLocalTyping) {
        console.log('📝 [TYPING] Starting typing');
        sendTypingStatus(true);
        setIsLocalTyping(true);
      }
      
      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      
      // Set new timeout to stop typing after inactivity
      typingTimeoutRef.current = setTimeout(() => {
        console.log('📝 [TYPING] Stopping typing due to timeout');
        if (isLocalTyping) {
          sendTypingStatus(false);
          setIsLocalTyping(false);
        }
        typingTimeoutRef.current = null;
      }, TYPING_TIMEOUT);
      
    } else {
      // Text is empty, stop typing
      console.log('📝 [TYPING] Text empty, stopping typing');
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
    
    console.log('📥 [RECEIVED] New message:', { 
      messageId, 
      type: msg.messageType,
    });
  
    setAllMessages((prevMessages) => {
      const exists = prevMessages.some(m => 
        m.id === messageId || 
        m.serverMessageId === messageId ||
        m.tempId === messageId
      );
      
      if (exists) {
        console.log('📥 [RECEIVED] Message already exists, skipping');
        return prevMessages;
      }
  
      const receivedMessage = {
        id: messageId,
        serverMessageId: messageId,
        tempId: messageId,
        type: msg.messageType || msg.fileCategory || "text",
        mediaType: msg.fileCategory || null,
        text: msg.text || msg.content || "",
        time: moment(msg.createdAt || new Date()).format("hh:mm A"),
        date: moment(msg.createdAt || new Date()).format("YYYY-MM-DD"),
        senderId: normalizeId(msg.senderId),
        senderType: computeSenderType(msg.senderId, currentUserIdRef.current),
        receiverId: normalizeId(msg.receiverId),
        status: undefined,
        mediaUrl: msg.mediaUrl || msg.url || null,
        previewUrl: msg.previewUrl || msg.thumbnailUrl || msg.mediaUrl || msg.url || null,
        createdAt: msg.createdAt || new Date().toISOString(),
        timestamp: new Date(msg.createdAt || new Date()).getTime(),
        synced: true,
        localUri: null,
        chatId: msg.chatId || chatIdRef.current,
      };

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
  
      const messageId = msg.serverMessageId || msg.id;
      if (!messageId) return;
  
      setDownloadProgress(prev => ({
        ...prev,
        [messageId]: 0
      }));
  
      const action = await dispatch(downloadMedia({ mediaId: messageId }));
      // console.log("action media download ----- ", action)
  
      const remoteUrl =
        action?.payload?.data?.downloadUrl ||
        action?.payload?.downloadUrl ||
        msg.mediaUrl ||
        msg.previewUrl;
  
      if (!remoteUrl) {
        throw new Error("No download URL found");
      }
  // console.log("remoteUrl", remoteUrl)
      const localUri = await downloadRemoteToReceived(
        remoteUrl,
        messageId,
        (progress) => {
          console.log("progress", progress)
          setDownloadProgress(prev => ({
            ...prev,
            [messageId]: progress
          }));
        }
      );
  console.log("localUri", localUri)
      if (!localUri) throw new Error("Download failed");
  
      try {
        await saveFileToMediaLibrary(localUri, APP_FOLDER);
      } catch (_) {}
  
      setMessages(prev =>
        prev.map(m =>
          (m.serverMessageId === messageId || m.id === messageId)
            ? { ...m, localUri }
            : m
        )
      );
  
      setAllMessages(prev => {
        const updated = prev.map(m =>
          (m.serverMessageId === messageId || m.id === messageId)
            ? { ...m, localUri }
            : m
        );
        saveMessagesToLocal(updated);
        return updated;
      });
  
      setDownloadProgress(prev => {
        const copy = { ...prev };
        delete copy[messageId];
        return copy;
      });
  
    } catch (error) {
      console.log("❌ handleDownloadMedia error:", error);
      Alert.alert("Download failed", error?.message || "Unable to download media");
  
      setDownloadProgress(prev => {
        const copy = { ...prev };
        delete copy[msg?.id];
        return copy;
      });
    }
  };

  const sendMedia = useCallback(async (mediaObj) => {
    // console.log("mediaObj --------", mediaObj)
    if (!mediaObj || !mediaObj.file) return;
    const { file, type } = mediaObj;
    const tempId = `temp_media_${Date.now()}_${Math.random()}`;
    const timestamp = new Date().toISOString();
  
    let persistentUri;
    try {
      const suggestedName = `sent_${chatIdRef.current || 'chat'}_${Date.now()}_${(file.name || '').replace(/\s+/g, '_')}`;
      const copied = await copyToAppFolder(file.uri, suggestedName, SENT_DIR, (p) => setDownloadProgress(prev => ({ ...prev, [tempId]: p })));
      persistentUri = copied ? normalizeUri(copied) : normalizeUri(file.uri);
      
      console.log('🔵 [SEND MEDIA] File copied to SENT_DIR:', persistentUri);
    } catch (err) {
      console.warn('Could not persist file, using original uri', err);
      persistentUri = normalizeUri(file.uri);
    }
  
    const localMsg = {
      id: tempId,
      tempId,
      type: type === 'document' ? 'file' : type,
      text: file.name || '',
      mediaUrl: '',
      previewUrl: persistentUri,
      localUri: persistentUri,
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
        file: { ...file, uri: persistentUri }, 
        tempId 
      },
      synced: false,
      chatId: chatIdRef.current,
      useLocalForSender: true
    };
  
    setAllMessages(prev => {
      const updated = [localMsg, ...prev];
      const uniqueMessages = deduplicateMessages(updated);
      saveMessagesToLocal(uniqueMessages);
      return uniqueMessages;
    });
  
    try {
      console.log('📤 [SEND MEDIA] Uploading to server...');
      const action = await uploadMediaFile({ 
        file: { ...file, uri: persistentUri }, 
        chatId: chatIdRef.current, 
        dispatch, 
        mediaUploadAction: mediaUpload 
      });
      
      // console.log("action?.payload", action?.payload)
      const payloadData = action?.payload || action;
      const success = payloadData && (payloadData.status === true || payloadData.statusCode === 200 || payloadData.success === true);
      
      if (!success) {
        console.error('❌ [SEND MEDIA] Upload failed:', payloadData);
        setAllMessages(prev => prev.map(m => m.tempId === tempId ? { ...m, status: 'failed' } : m));
        return;
      }
  
      // console.log("payloadData", payloadData)
      const responseData = payloadData.data || payloadData;
      // console.log("responseData", responseData)
      const mediaUrl = responseData?.url || responseData?.mediaUrl || responseData?.path || responseData?.filePath || null;
      const previewUrl = responseData?.previewUrl || responseData?.thumbnailUrl || mediaUrl;
      const serverMessageId = responseData?.messageId || responseData?._id || null;
  
      console.log('✅ [SEND MEDIA] Upload successful. Server URLs:', { mediaUrl, previewUrl });
  
      setAllMessages(prevMessages => {
        const withoutTemp = prevMessages.filter(m => m.tempId !== tempId && m.id !== tempId);
        
        const permanentMsg = {
          id: serverMessageId || `msg_${Date.now()}`,
          serverMessageId: serverMessageId,
          tempId: serverMessageId,
          type: type === 'document' ? 'file' : type,
          text: file.name || '',
          mediaUrl: persistentUri,
          previewUrl: persistentUri,
          localUri: persistentUri,
          serverMediaUrl: mediaUrl,
          serverPreviewUrl: previewUrl,
          time: moment(timestamp).format("hh:mm A"),
          date: moment(timestamp).format("YYYY-MM-DD"),
          senderId: currentUserIdRef.current,
          senderType: 'self',
          receiverId: chatData.peerUser._id,
          status: 'sent',
          createdAt: timestamp,
          timestamp: new Date(timestamp).getTime(),
          synced: true,
          payload: { 
            file: { ...file, uri: persistentUri } 
          },
          chatId: chatIdRef.current,
          useLocalForSender: true,
          mediaId: responseData?.mediaId || responseData?.id || null
        };
  
        console.log('✅ [SEND MEDIA] Created permanent message with localUri:', persistentUri);
  
        const updated = [permanentMsg, ...withoutTemp];
        const uniqueMessages = deduplicateMessages(updated);
        const sorted = uniqueMessages.sort((a, b) => b.timestamp - a.timestamp);
        
        saveMessagesToLocal(sorted);
        return sorted;
      });
  
      if (mediaUrl || previewUrl) {
        // Always use _id.$oid for MongoDB if present
        let mediaId = null;
        if (responseData?._id && responseData._id.$oid) {
          mediaId = String(responseData._id.$oid);
        } else if (responseData?._id) {
          mediaId = String(responseData._id);
        } else if (responseData?.mediaId) {
          mediaId = String(responseData.mediaId);
        } else if (serverMessageId) {
          mediaId = String(serverMessageId);
        }

        const socketPayload = {
          chatId: chatIdRef.current,
          senderId: currentUserIdRef.current,
          receiverId: chatData.peerUser._id,
          messageType: type === 'document' ? 'file' : type,
          mediaUrl: mediaUrl || previewUrl,
          previewUrl: previewUrl || mediaUrl,
          text: file.name || '',
          messageId: serverMessageId,
          createdAt: timestamp,
          mediaId,
        };
  
        try {
          const socket = socketRef.current || getSocket();
          if (socket && isSocketConnected()) {
            socket.emit('message:send', socketPayload);
            console.log('📨 [SEND MEDIA] Sent to receiver with server URLs');
          }
        } catch (err) {
          console.warn('⚠️ [SEND MEDIA] Socket send failed:', err);
        }
      }
  
    } catch (err) {
      console.error('❌ [SEND MEDIA] Error:', err);
      setAllMessages(prev => prev.map(m => m.tempId === tempId ? { ...m, status: 'failed' } : m));
    } finally {
      setPendingMedia(null);
      setDownloadProgress(prev => { const p = { ...prev }; delete p[tempId]; return p; });
    }
  }, [dispatch, chatData.peerUser, deduplicateMessages, saveMessagesToLocal]);

  const resendMessage = useCallback(async (msg) => {
    if (!msg) return;
    if (msg.mediaUrl) {
      const payload = {
        chatId: chatIdRef.current,
        senderId: currentUserIdRef.current,
        receiverId: chatData.peerUser._id,
        messageType: msg.type,
        mediaUrl: msg.mediaUrl,
        previewUrl: msg.previewUrl || msg.mediaUrl,
        text: msg.text || '',
        tempId: msg.tempId || `temp_retry_${Date.now()}`,
        createdAt: new Date().toISOString(),
        mediaId: msg.mediaId || null
      };
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
  }, [sendMessageViaSocket, sendMedia, chatData.peerUser]);

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
    const oldest = allMessages.length > 0
      ? allMessages.reduce((acc, msg) => {
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
  }, [isLoadingMore, hasMoreMessages, currentPage, dispatch, allMessages, fetchAndSyncMessagesViaSocket]);

  /* ========== FIXED: Render status helper ========== */
  const renderStatusText = useCallback(() => {
    console.log('📊 [STATUS] Rendering status:', { 
      isPeerTyping, 
      userStatus, 
      lastSeen 
    });
    
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
    if (allMessages.length > 0) {
      const ids = new Set();
      const duplicates = [];
      
      allMessages.forEach(msg => {
        const msgId = msg.serverMessageId || msg.id;
        if (ids.has(msgId)) {
          duplicates.push(msg);
        } else {
          ids.add(msgId);
        }
      });
      
      if (duplicates.length > 0) {
        console.log('🧹 Found duplicates:', duplicates.length);
        
        const uniqueMessages = [];
        const seenIds = new Set();
        
        allMessages.forEach(msg => {
          const msgId = msg.serverMessageId || msg.id;
          if (!seenIds.has(msgId)) {
            seenIds.add(msgId);
            uniqueMessages.push(msg);
          }
        });
        
        const sorted = uniqueMessages.sort((a, b) => 
          (b.timestamp || 0) - (a.timestamp || 0)
        );
        
        setAllMessages(sorted);
        saveMessagesToLocal(sorted);
      }
    }
  }, [allMessages.length, saveMessagesToLocal]);

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
    pendingMedia, setPendingMedia, sendMedia, handlePickMedia, showMediaOptions, openMediaOptions, closeMediaOptions,
    mediaViewer, closeMediaViewer, handleDownloadMedia, downloadedMedia, downloadProgress,
    onRefresh, loadMoreMessages, isLoadingMore, hasMoreMessages,
    manualReloadMessages,
    refreshMessagesFromLocal,
    isChatMuted, muteUntil, toggleChatMute,
    markVisibleIncomingAsRead,
    setMessages, saveMessagesToLocal, resendMessage,
  };
}