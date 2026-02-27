/**
 * hooks/useChatLogic.js
 *
 * Full chat logic hook with complete socket handling, message storage,
 * send/receive, typing/presence, media upload/download flows and sender-side
 * persistent storage for sent media (so sender images don't disappear after app restart).
 */

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

/* mediaService: copyToAppFolder, saveFileToMediaLibrary, normalizeUri, uploadMediaFile, downloadAndOpenMedia */
import {
  copyToAppFolder,
  saveFileToMediaLibrary,
  normalizeUri,
  uploadMediaFile,
  downloadAndOpenMedia,
  SENT_DIR,
  APP_FOLDER,
} from "../utils/mediaService";

/* Constants */
const MAX_LOCAL_SAVE = 300;
const MAX_RECONNECT_ATTEMPTS = 5;
const TYPING_TIMEOUT = 3000; // 3 seconds

export default function useChatLogic({ navigation, route }) {
  const dispatch = useDispatch();
  const { isConnected } = useNetwork();
  const { pickMedia } = useImage();
  const chatMessagesData = useSelector(state => state.chat?.chatMessagesData || state.chat?.data || state.chat);

  // Build chatData safely from route.params (supports both `item` and `user`)
  const { item, chatId: routeChatId, user } = (route && route.params) || {};
  const chatData = (item && item.peerUser)
    ? { peerUser: item.peerUser, chatId: item.chatId || item._id }
    : (user ? { peerUser: user, chatId: routeChatId } : { peerUser: null, chatId: null });

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
  const [userStatus, setUserStatus] = useState("offline");
  const [lastSeen, setLastSeen] = useState(null);
  
  // FIXED: Separate typing states for local user and peer
  const [isPeerTyping, setIsPeerTyping] = useState(false); // Peer is typing
  const [isLocalTyping, setIsLocalTyping] = useState(false); // Local user is typing
  
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch network connectivity
  useEffect(() => {
    if (isConnected) {
      reconnectAttempts.current = 0;
      checkAndReconnectSocket();
    } else {
      setUserStatus("offline");
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    }
  }, [isConnected]);

  // App state changes
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener("change", nextAppState => {
      if (appState.current.match(/inactive|background/) && nextAppState === "active") {
        reconnectAttempts.current = 0;
        checkAndReconnectSocket();
        requestUserPresence();
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
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      }
      appState.current = nextAppState;
    });
    return () => { appStateSubscription.remove(); };
  }, [isLocalTyping]);

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
    }, 30000);
    return () => { if (socketCheckInterval.current) clearInterval(socketCheckInterval.current); };
  }, []);

  // Filter messages by current chat ID
  useEffect(() => {
    if (chatId && allMessages.length > 0) {
      const filteredMessages = allMessages.filter(msg => 
        msg.chatId === chatId || 
        msg.receiverId === chatData.peerUser?._id ||
        msg.senderId === chatData.peerUser?._id ||
        (msg.receiverId === currentUserId && msg.senderId === chatData.peerUser?._id) ||
        (msg.senderId === currentUserId && msg.receiverId === chatData.peerUser?._id)
      );
      
      const sorted = filteredMessages.sort((a, b) => 
        (b.timestamp || 0) - (a.timestamp || 0)
      );
      
      setMessages(sorted);
    }
  }, [chatId, allMessages, chatData.peerUser?._id, currentUserId]);

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
      setChatId(generatedChatId);
      chatIdRef.current = generatedChatId;

      setMessages([]);
      setAllMessages([]);

      await loadMessagesFromLocal(generatedChatId);

      await checkAndReconnectSocket();

      const socket = getSocket();
      if (socket && isSocketConnected()) {
        socketRef.current = socket;
        setupSocketListeners(socket, generatedChatId);
        requestUserPresence();
        socket.emit('user:status', { userId, status: 'online', chatId: generatedChatId });
        socket.emit('chat:join', { chatId: generatedChatId, userId }, (response) => {});
        presenceCheckInterval.current = setInterval(() => {
          if (isSocketConnected()) requestUserPresence();
          else checkAndReconnectSocket();
        }, 30000);
      } else {
        setUserStatus("offline");
      }

      fetchMessagesFromAPI(generatedChatId);

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
  
      if (!savedMessages) return;
  
      const parsed = JSON.parse(savedMessages);
      
      const processed = parsed.map(msg => {
        if (msg.senderId === currentUserIdRef.current && msg.type !== 'text') {
          if (msg.localUri) {
            console.log('📖 Loading sender media with localUri:', msg.id, msg.localUri);
            return {
              ...msg,
              previewUrl: msg.localUri,
              mediaUrl: msg.localUri,
              localUri: msg.localUri
            };
          }
          
          if (msg.payload?.file?.uri) {
            console.log('📖 Recovering localUri from payload:', msg.id);
            return {
              ...msg,
              localUri: msg.payload.file.uri,
              previewUrl: msg.payload.file.uri,
              mediaUrl: msg.payload.file.uri
            };
          }
        }
        return msg;
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
  
    } catch (err) {
      console.error("Error loading from local storage:", err);
    }
  };

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
        localUri: msg.localUri || null,
      }));
      
      await AsyncStorage.setItem(localKey, JSON.stringify(cleanMessages));
      console.log('💾 [SAVE TO LOCAL] Save complete');
    } catch (err) {
      console.error("Failed to save to local storage:", err);
    }
  }, [deduplicateMessages]);

  /* ========== API fetch handler ========= */
  const fetchMessagesFromAPI = async (chatIdParam) => {
    try {
      dispatch(chatMessage({ chatId: chatIdParam, search: '', page: 1, limit: 50 }));
    } catch (err) {
      console.error("fetchMessagesFromAPI error", err);
    }
  };

  useEffect(() => {
    const docs = chatMessagesData?.data?.docs || chatMessagesData?.docs || null;
    const hasNext = chatMessagesData?.data?.hasNextPage || chatMessagesData?.hasNextPage || false;
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
        const serverId = apiMsg._id || apiMsg.messageId;

        let existingIndex = mergedMessages.findIndex(m =>
          m.serverMessageId === serverId ||
          m.id === serverId
        );

        if (existingIndex === -1) {
          existingIndex = mergedMessages.findIndex(localMsg =>
            localMsg.senderId === apiMsg.senderId &&
            Math.abs(
              new Date(localMsg.createdAt).getTime() -
              new Date(apiMsg.createdAt).getTime()
            ) < 5000
          );
        }

        const formattedMessage = {
          id: serverId,
          serverMessageId: serverId,
          tempId: serverId,
          type: apiMsg.messageType || apiMsg.fileCategory || "text",
          mediaType: apiMsg.fileCategory || null,
          text: apiMsg.text || apiMsg.content || "",
          time: moment(apiMsg.createdAt).format("hh:mm A"),
          date: moment(apiMsg.createdAt).format("YYYY-MM-DD"),
          senderId: apiMsg.senderId,
          receiverId: apiMsg.receiverId,
          status: apiMsg.senderId === currentUserIdRef.current ? "sent" : undefined,
          mediaUrl: apiMsg.mediaUrl || apiMsg.url || null,
          previewUrl: apiMsg.previewUrl || apiMsg.thumbnailUrl || apiMsg.mediaUrl || null,
          createdAt: apiMsg.createdAt,
          timestamp: new Date(apiMsg.createdAt).getTime(),
          synced: true,
          chatId: apiMsg.chatId || chatIdRef.current,
        };

        if (existingIndex !== -1 && mergedMessages[existingIndex]?.localUri) {
          formattedMessage.localUri = mergedMessages[existingIndex].localUri;
          formattedMessage.previewUrl = mergedMessages[existingIndex].localUri;
          formattedMessage.mediaUrl = mergedMessages[existingIndex].localUri;
        }

        if (existingIndex !== -1) {
          mergedMessages[existingIndex] = formattedMessage;
        } else {
          mergedMessages.push(formattedMessage);
        }
      });

      const uniqueMessages = deduplicateMessages(mergedMessages);
      const sorted = uniqueMessages.sort(
        (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
      );

      saveMessagesToLocal(sorted);
      console.log('✅ [PROCESS API] Final message count:', sorted.length);

      return sorted;
    });

  }, [deduplicateMessages, saveMessagesToLocal]);

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
  const requestUserPresence = useCallback(() => {
    const socket = socketRef.current || getSocket();
  
    if (!socket || !isSocketConnected() || !chatData.peerUser?._id) {
      console.log("⚠️ Cannot request presence");
      setUserStatus("offline");
      return;
    }
  
    console.log("📤 Requesting presence for:", chatData.peerUser._id);
  
    socket.emit(
      "presence:manual",
      { userId: chatData.peerUser._id },
      (response) => {
        console.log("📥 presence:manual response:", response);
  
        const data = response?.data || response;
  
        if (data?.status) {
          setUserStatus(data.status);
          setLastSeen(data.lastSeen || null);
        }
      }
    );
  }, [chatData.peerUser]);

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
    socket.off('message:new');
    socket.off('message:received');
    socket.off('message:delivered');
    socket.off('message:read');
    socket.off('message:delete:everyone');
    socket.off('message:delete:me');
    socket.off('messagedeleteeveryone:response');
    socket.off('messagedeleteme:response');
    socket.off('presence:update');
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
    socket.onAny((event, data) => {
      console.log("📡 SOCKET EVENT:", event, data);
    });
    /* ================= MESSAGE EVENTS ================= */
  
    socket.on('message:sent:ack', (data) => {
      const messageId =
        data.messageId ||
        data._id ||
        data.data?.messageId ||
        data.data?._id;
  
      const tempId = data.tempId || data.data?.tempId;
  
      if (data.persistenceConfirmed === true || data.status === true || messageId) {
        updateMessageStatus(tempId, 'sent', { messageId, ...data });
      }
    });
  
    socket.on('message:new', (data) => {
      const chatInPayload = data.chatId || data.chat || data.roomId;
      if (chatInPayload && chatInPayload !== currentChatId) return;
      handleReceivedMessage(data);
    });
  
    socket.on('message:received', handleReceivedMessage);
  
    socket.on('message:delivered', (data) => {
      if (data.messageId) updateMessageStatus(data.messageId, 'delivered', data);
    });
  
    socket.on('message:read', (data) => {
      if (data.messageId) updateMessageStatus(data.messageId, 'seen', data);
    });
  
    socket.on('message:delete:everyone', (data) => {
      const { messageId, chatId } = data;
      if (chatId !== currentChatId) return;
      handleDeleteMessage(messageId, true);
    });
  
    socket.on('message:delete:me', (data) => {
      const { messageId, chatId, deletedBy } = data;
      if (chatId !== currentChatId) return;
      if (deletedBy && deletedBy === currentUserIdRef.current)
        handleDeleteMessage(messageId, false);
    });
  
    /* ================= PRESENCE EVENTS ================= */
  
    socket.on('presence:update', (data) => {
      console.log('📨 presence:update:', data);
  
      const incomingId = data.userId || data.id;
  
      if (String(incomingId) === String(chatData.peerUser?._id)) {
        console.log('✅ Updating peer presence');
  
        setUserStatus(data.status || "offline");
  
        if (data.lastSeen) {
          setLastSeen(data.lastSeen);
        }
      }
    });
  
    socket.on('user:online', (data) => {
      console.log('📨 user:online:', data);
  
      const incomingId = data.userId || data.id;
  
      if (String(incomingId) === String(chatData.peerUser?._id)) {
        setUserStatus("online");
        setLastSeen(null);
      }
    });
  
    socket.on('user:offline', (data) => {
      console.log('📨 user:offline:', data);
  
      const incomingId = data.userId || data.id;
  
      if (String(incomingId) === String(chatData.peerUser?._id)) {
        setUserStatus("offline");
        setLastSeen(data.lastSeen || new Date().toISOString());
      }
    });
  
    /* ================= TYPING EVENTS ================= */
  
    socket.on('typing:start', (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.roomId;
  
      if (
        String(senderId) === String(chatData.peerUser?._id) &&
        (!chatIdInPayload || chatIdInPayload === currentChatId)
      ) {
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
  
    socket.on('typing:stop', (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.roomId;
  
      if (
        String(senderId) === String(chatData.peerUser?._id) &&
        (!chatIdInPayload || chatIdInPayload === currentChatId)
      ) {
        setIsPeerTyping(false);
  
        if (peerTypingTimeoutRef.current) {
          clearTimeout(peerTypingTimeoutRef.current);
          peerTypingTimeoutRef.current = null;
        }
      }
    });
  
    socket.on('typing:recording', (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.roomId;
  
      if (
        String(senderId) === String(chatData.peerUser?._id) &&
        (!chatIdInPayload || chatIdInPayload === currentChatId)
      ) {
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
  
      if (
        String(senderId) === String(chatData.peerUser?._id) &&
        (!chatIdInPayload || chatIdInPayload === currentChatId)
      ) {
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
  
    /* ================= CONNECTION EVENTS ================= */
  
    socket.on('disconnect', () => {
      setUserStatus("offline");
      setIsPeerTyping(false);
  
      setTimeout(() => {
        if (isComponentMounted.current) {
          checkAndReconnectSocket();
        }
      }, 2000);
    });
  
    socket.on('connect', () => {
      console.log("🟢 Socket connected");
  
      reconnectAttempts.current = 0;
  
      /* 🔥 CRITICAL FIX: Join USER room */
      socket.emit("user:join", {
        userId: currentUserIdRef.current
      });
  
      /* Join chat room */
      socket.emit('chat:join', {
        chatId: currentChatId,
        userId: currentUserIdRef.current
      });
  
      /* Mark self online */
      socket.emit('user:status', {
        userId: currentUserIdRef.current,
        status: 'online',
        chatId: currentChatId
      });
  
      /* 🔥 Force presence refresh AFTER join */
      setTimeout(() => {
        requestUserPresence();
      }, 800);
    });
  
  }, [
    chatData.peerUser,
    removeSocketListeners,
    requestUserPresence,
    checkAndReconnectSocket
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

        const updatedMsg = { ...msg, status };
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
  }, [removeDuplicateMessages, saveMessagesToLocal]);

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
    
    const newMessage = {
      id: tempId,
      tempId,
      type: "text",
      text: text.trim(),
      time: moment(timestamp).format("hh:mm A"),
      date: moment(timestamp).format("YYYY-MM-DD"),
      senderId: currentUserIdRef.current,
      receiverId: chatData.peerUser._id,
      status: "sending",
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      payload,
      synced: false,
      chatId: chatIdRef.current,
    };

    setText("");
    
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
  }, [text, chatData.peerUser, sendTypingStatus, removeDuplicateMessages, saveMessagesToLocal, updateMessageStatus, dispatch, checkAndReconnectSocket, isLocalTyping]);

  /* ========== FIXED: Text input change handler with proper typing ========== */
  const handleTextChange = useCallback((value) => {
    setText(value);
    
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
  }, [sendTypingStatus, isLocalTyping]);

  const handleReceivedMessage = useCallback(async (msg) => {
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
        senderId: msg.senderId,
        receiverId: msg.receiverId,
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
      
      return sorted;
    });
  }, [saveMessagesToLocal, deduplicateMessages]);

  const handleDeleteMessage = useCallback((messageId, isDeletedForEveryone) => {
    setAllMessages(prevMessages => {
      const filtered = prevMessages.filter(msg => !(msg.id === messageId || msg.serverMessageId === messageId || msg.tempId === messageId));
      saveMessagesToLocal(filtered);
      return filtered;
    });
  }, [saveMessagesToLocal]);

  const handleToggleSelectMessages = useCallback((messageId) => {
    setSelectedMessages((prevSelected) => prevSelected.includes(messageId) ? prevSelected.filter((id) => id !== messageId) : [...prevSelected, messageId]);
  }, []);

  const deleteSelectedMessages = useCallback(async (deleteForEveryone) => {
    try {
      const socket = getSocket();
      const filtered = messages.filter(msg => !selectedMessage.includes(msg.id));
      setAllMessages(filtered);
      saveMessagesToLocal(filtered);
      if (socket && isSocketConnected()) {
        for (const messageId of selectedMessage) {
          const message = messages.find(m => m.id === messageId);
          if (deleteForEveryone && message && message.senderId === currentUserIdRef.current) {
            socket.emit('message:delete:everyone', { messageId, chatId: chatIdRef.current });
          } else {
            socket.emit('message:delete:me', { messageId, chatId: chatIdRef.current });
          }
        }
      }
      setSelectedMessages([]);
    } catch (error) {
      Alert.alert("Error", "Failed to delete messages");
    }
  }, [messages, selectedMessage, saveMessagesToLocal]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedMessage.length === 0) return;
    const allMyMessages = selectedMessage.every(msgId => {
      const msg = messages.find(m => m.id === msgId);
      return msg && msg.senderId === currentUserIdRef.current;
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
  
      const remoteUrl =
        action?.payload?.data?.url ||
        action?.payload?.url ||
        msg.mediaUrl ||
        msg.previewUrl;
  
      if (!remoteUrl) {
        throw new Error("No download URL found");
      }
  
      const localUri = await downloadRemoteToReceived(
        remoteUrl,
        messageId,
        (progress) => {
          setDownloadProgress(prev => ({
            ...prev,
            [messageId]: progress
          }));
        }
      );
  
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
      
      const payloadData = action?.payload || action;
      const success = payloadData && (payloadData.status === true || payloadData.statusCode === 200 || payloadData.success === true);
      
      if (!success) {
        console.error('❌ [SEND MEDIA] Upload failed:', payloadData);
        setAllMessages(prev => prev.map(m => m.tempId === tempId ? { ...m, status: 'failed' } : m));
        return;
      }
  
      const responseData = payloadData.data || payloadData;
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
          receiverId: chatData.peerUser._id,
          status: 'sent',
          createdAt: timestamp,
          timestamp: new Date(timestamp).getTime(),
          synced: true,
          payload: { 
            file: { ...file, uri: persistentUri } 
          },
          chatId: chatIdRef.current,
          useLocalForSender: true
        };
  
        console.log('✅ [SEND MEDIA] Created permanent message with localUri:', persistentUri);
  
        const updated = [permanentMsg, ...withoutTemp];
        const uniqueMessages = deduplicateMessages(updated);
        const sorted = uniqueMessages.sort((a, b) => b.timestamp - a.timestamp);
        
        saveMessagesToLocal(sorted);
        return sorted;
      });
  
      if (mediaUrl || previewUrl) {
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
    reconnectAttempts.current = 0;
    await checkAndReconnectSocket();
    await syncMessagesToAPI();
    setHasLoadedFromAPI(false);
    setCurrentPage(1);
    setHasMoreMessages(true);
    dispatch(chatMessage({ chatId: chatIdRef.current, search: '', page: 1, limit: 50 }));
    setTimeout(() => setIsRefreshing(false), 1000);
  }, [dispatch, checkAndReconnectSocket]);

  const loadMoreMessages = useCallback(() => {
    if (isLoadingMore) return;
    if (!hasMoreMessages) return;
    const nextPage = currentPage + 1;
    setIsLoadingMore(true);
    setCurrentPage(nextPage);
    dispatch(chatMessage({ chatId: chatIdRef.current, search: '', page: nextPage, limit: 50 }));
  }, [isLoadingMore, hasMoreMessages, currentPage, dispatch]);

  /* ========== FIXED: Render status helper ========== */
  const renderStatusText = useCallback(() => {
    console.log("📊 STATUS CHECK →", {
      isPeerTyping,
      userStatus,
      lastSeen,
      peerId: chatData.peerUser?._id
    });
  
    if (isPeerTyping) return "typing...";
    if (userStatus === "online") return "online";
    if (lastSeen) return `last seen ${moment(lastSeen).fromNow()}`;
    return "offline";
  }, [isPeerTyping, userStatus, lastSeen, chatData.peerUser]);

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
    messages, allMessages, isLoadingInitial, isLoadingFromLocal, isRefreshing, isSearching,
    // FIXED: Export the correct typing state
    isPeerTyping, // This is what the UI should use for "typing..." indicator
    isLocalTyping, // Optional: if UI needs to know local typing state
    userStatus, renderStatusText,
    search, handleSearch, clearSearch, goToNextResult, goToPreviousResult, searchResults, currentSearchIndex,
    selectedMessage, handleToggleSelectMessages, handleDeleteSelected,
    text, setText, handleTextChange, handleSendText,
    pendingMedia, setPendingMedia, sendMedia, handlePickMedia, showMediaOptions, openMediaOptions, closeMediaOptions,
    mediaViewer, closeMediaViewer, handleDownloadMedia, downloadedMedia, downloadProgress,
    onRefresh, loadMoreMessages, isLoadingMore, hasMoreMessages,
    setMessages, saveMessagesToLocal, resendMessage,
  };
}