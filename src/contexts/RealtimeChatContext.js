import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';
import { subscribeSessionReset, subscribeUserChanged } from '../services/sessionEvents';

const TYPING_TTL = 10000;
const CHAT_HIGHLIGHT_TTL = 2000;
const CHAT_UPDATE_BATCH_WINDOW = 90;
const CHAT_LIST_CACHE_KEY = 'CHAT_LIST_CACHE';
const CHAT_LIST_SAVE_DEBOUNCE_MS = 300;

const REASON_TYPE_MAP = {
  'kafka.message.created': 'new_message',
  'kafka.message.read': 'message_read',
  'kafka.message.delivered': 'message_delivered',
  'message.created': 'new_message',
  'message.new': 'new_message',
  'kafka.message.edited': 'message_edited',
  'message.edited': 'message_edited',
  'kafka.message.deleted': 'message_deleted',
  'message.deleted': 'message_deleted',
  'message.read': 'message_read',
  'message.delivered': 'message_delivered',
  'chat.created': 'chat_created',
  'chat.archived': 'chat_archived',
  'chat.unarchived': 'chat_unarchived',
  'chat.pinned': 'chat_pinned',
  'chat.unpinned': 'chat_unpinned',
  'chat.muted': 'chat_muted',
  'chat.unmuted': 'chat_unmuted',
  'typing.started': 'typing_start',
  'typing.start': 'typing_start',
  'typing.stopped': 'typing_stop',
  'typing.stop': 'typing_stop',
  'presence.changed': 'presence_update',
  'presence.update': 'presence_update',
};

const MESSAGE_TYPE_ICON_MAP = {
  text: null,
  image: '📷',
  video: '📹',
  audio: '🎵',
  file: '📎',
  location: '📍',
  contact: '👤',
  sticker: '✨',
  gif: '🎞️',
};

const initialState = {
  currentUserId: null,
  activeChatId: null,
  chatMap: {},
  sortedChatIds: [],
  pinnedChatIds: [],
  regularChatIds: [],
  archivedChatIds: [],
  typingStates: {},
  presenceByUser: {},
  unreadByChat: {},
  highlightByChat: {},
  totalUnread: 0,
  hasHydratedCache: false,
};

const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (value?._id && value._id.$oid) return String(value._id.$oid);
    const candidate = value?._id || value?.id || value?.userId || value?.$oid || null;
    return candidate == null ? null : String(candidate);
  }
  return null;
};

const getPeerUserId = (chatLike = {}) => {
  return normalizeId(
    chatLike?.peerUser?._id ||
    chatLike?.peerUser?.userId ||
    chatLike?.peerUser?.id ||
    chatLike?.participantId ||
    chatLike?.userId ||
    null
  );
};

const findChatIdByPeer = (chatMap = {}, peerUserId, excludeChatId = null) => {
  if (!peerUserId) return null;

  const excluded = normalizeId(excludeChatId);
  const allIds = Object.keys(chatMap || {});
  for (const id of allIds) {
    if (excluded && id === excluded) continue;
    const candidatePeer = getPeerUserId(chatMap[id]);
    if (candidatePeer && candidatePeer === peerUserId) {
      return id;
    }
  }

  return null;
};

const toTimestamp = (value) => {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const formatRelativeTime = (value) => {
  const ts = toTimestamp(value);
  if (!ts) return '';

  const diffMs = Date.now() - ts;
  if (diffMs < 60000) return 'Just now';

  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) {
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  }

  const date = new Date(ts);
  const day = `${date.getDate()}`.padStart(2, '0');
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const year = `${date.getFullYear()}`.slice(-2);
  return `${day}/${month}/${year}`;
};

const formatLastSeen = (value) => {
  const ts = toTimestamp(value);
  if (!ts) return 'Last seen unavailable';

  const now = Date.now();
  const diffMs = now - ts;
  if (diffMs < 5 * 60000) return 'Last seen just now';
  if (diffMs < 60 * 60000) return `Last seen ${Math.max(1, Math.floor(diffMs / 60000))} min ago`;

  const date = new Date(ts);
  const nowDate = new Date(now);
  const isToday = date.toDateString() === nowDate.toDateString();
  if (isToday) {
    const hour = `${date.getHours()}`.padStart(2, '0');
    const min = `${date.getMinutes()}`.padStart(2, '0');
    return `Last seen at ${hour}:${min}`;
  }

  const yesterday = new Date(nowDate);
  yesterday.setDate(nowDate.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Last seen yesterday';
  }

  const day = `${date.getDate()}`.padStart(2, '0');
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const year = `${date.getFullYear()}`.slice(-2);
  return `Last seen on ${day}/${month}/${year}`;
};

const getMessageTypeDisplayText = (messageType, text, metadata = {}) => {
  const type = (messageType || 'text').toString().toLowerCase();
  const normalizedText = (text || '').toString().trim();

  if (type === 'text') return normalizedText || 'No messages yet';
  if (type === 'image') return 'Photo';
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  if (type === 'file') return metadata?.fileName || metadata?.name || 'File';
  if (type === 'location') return 'Location';
  if (type === 'contact') return 'Contact';
  if (type === 'sticker') return 'Sticker';
  if (type === 'gif') return 'GIF';

  return normalizedText || 'No messages yet';
};

const buildLastMessageDisplay = ({ chat, currentUserId, isTyping }) => {
  if (isTyping) {
    return {
      text: 'Typing...',
      icon: null,
      prefix: '',
      isEdited: false,
      fullText: 'Typing...',
    };
  }

  const rawLastMessage = chat?.lastMessage;
  const messageText = typeof rawLastMessage === 'string' ? rawLastMessage : (rawLastMessage?.text || chat?.lastMessage || '');
  const messageType = (chat?.lastMessageType || rawLastMessage?.type || 'text').toString().toLowerCase();
  const messageSender = chat?.lastMessageSender || rawLastMessage?.senderId || null;
  const isEdited = Boolean(rawLastMessage?.isEdited || chat?.lastMessageEdited || rawLastMessage?.editedAt);
  const icon = MESSAGE_TYPE_ICON_MAP[messageType] || null;
  const baseText = getMessageTypeDisplayText(messageType, messageText, rawLastMessage?.mediaMeta || rawLastMessage?.metadata || {});
  const prefix = currentUserId && messageSender && String(currentUserId) === String(messageSender) ? 'You: ' : '';
  const editedSuffix = isEdited ? ' (edited)' : '';

  return {
    text: baseText,
    icon,
    prefix,
    isEdited,
    fullText: `${prefix}${icon ? `${icon} ` : ''}${baseText}${editedSuffix}`.trim(),
  };
};

const sortByActivity = (chatMap, ids) => {
  return [...ids].sort((a, b) => {
    const chatA = chatMap[a] || {};
    const chatB = chatMap[b] || {};
    const tsA = getChatTimestampValue(chatA);
    const tsB = getChatTimestampValue(chatB);
    return tsB - tsA;
  });
};

const buildOrderedSections = (chatMap) => {
  const allIds = Object.keys(chatMap || {});
  const pinned = [];
  const regular = [];
  const archived = [];

  allIds.forEach((chatId) => {
    const chat = chatMap[chatId] || {};
    if (chat?.isArchived) {
      archived.push(chatId);
      return;
    }

    if (chat?.isPinned) {
      pinned.push(chatId);
      return;
    }

    regular.push(chatId);
  });

  const pinnedChatIds = sortByActivity(chatMap, pinned);
  const regularChatIds = sortByActivity(chatMap, regular);
  const archivedChatIds = sortByActivity(chatMap, archived);

  return {
    pinnedChatIds,
    regularChatIds,
    archivedChatIds,
    sortedChatIds: [...pinnedChatIds, ...regularChatIds],
  };
};

const normalizeChatListUpdate = (payload = {}) => {
  const source = unwrapPayload(payload);
  const item = source?.item || {};
  const reason = (source?.reason || '').toString().toLowerCase();
  const type = (source?.type || REASON_TYPE_MAP[reason] || reason || 'unknown').toString().toLowerCase();
  const chatId = normalizeId(source?.chatId || item?.chatId || item?._id || null);

  if (!chatId) return null;

  return {
    chatId,
    type,
    reason,
    item,
    timestamp: Number(source?.timestamp || item?.lastMessageAt || Date.now()),
  };
};

const normalizeMessageDeliveryStatus = (status) => {
  const value = String(status || '').toLowerCase();
  if (value === 'seen' || value === 'read') return 'read';
  if (value === 'delivered') return 'delivered';
  if (value === 'sent' || value === 'sending' || value === 'pending') return 'sent';
  return null;
};

const MESSAGE_STATUS_PRIORITY = {
  sent: 1,
  delivered: 2,
  read: 3,
};

const getMessageStatusPriority = (status) => {
  const normalized = normalizeMessageDeliveryStatus(status);
  return normalized ? (MESSAGE_STATUS_PRIORITY[normalized] || 0) : 0;
};

const pickHighestMessageStatus = (currentStatus, incomingStatus) => {
  const currentNormalized = normalizeMessageDeliveryStatus(currentStatus);
  const incomingNormalized = normalizeMessageDeliveryStatus(incomingStatus);
  if (!incomingNormalized) return currentNormalized;
  if (!currentNormalized) return incomingNormalized;
  return getMessageStatusPriority(incomingNormalized) >= getMessageStatusPriority(currentNormalized)
    ? incomingNormalized
    : currentNormalized;
};

const getMessageIdentifier = (message = {}) => {
  return normalizeId(
    message?.serverMessageId ||
    message?.messageId ||
    message?.id ||
    message?.tempId ||
    message?._id ||
    null
  );
};

const buildLastMessageFromItem = (existingChat, item, fallbackTimestamp) => {
  const baseLastMessage = existingChat?.lastMessage || {};
  const messageText =
    item?.lastMessage?.text ||
    item?.lastMessage ||
    item?.text ||
    baseLastMessage?.text ||
    '';

  const status = pickHighestMessageStatus(
    baseLastMessage?.status,
    item?.lastMessageStatus || item?.status || item?.lastMessage?.status || null
  );

  return {
    ...baseLastMessage,
    serverMessageId: item?.lastMessage?.serverMessageId || item?.lastMessage?.messageId || item?.messageId || baseLastMessage?.serverMessageId || null,
    messageId: item?.lastMessage?.messageId || item?.messageId || baseLastMessage?.messageId || null,
    tempId: item?.lastMessage?.tempId || item?.tempId || baseLastMessage?.tempId || null,
    id: item?.lastMessage?.id || item?.messageId || item?.id || baseLastMessage?.id || null,
    text: messageText,
    type: item?.lastMessageType || item?.lastMessage?.type || baseLastMessage?.type || 'text',
    createdAt: item?.lastMessageAt || item?.lastMessage?.createdAt || fallbackTimestamp || baseLastMessage?.createdAt || Date.now(),
    senderId: item?.lastMessageSender || item?.lastMessage?.senderId || baseLastMessage?.senderId || null,
    status,
  };
};

const normalizeStatus = (status) => {
  const value = (status || '').toString().toLowerCase();
  if (value === 'online' || value === 'away' || value === 'busy') return value;
  return 'offline';
};

const getChatTimestampValue = (chat = {}) => {
  return toTimestamp(
    chat?.timestamp ||
    chat?.lastMessageAt ||
    chat?.lastMessage?.createdAt ||
    chat?.updatedAt ||
    0
  );
};

const getChatTimestampIso = (chat = {}) => {
  return (
    chat?.timestamp ||
    chat?.lastMessageAt ||
    chat?.lastMessage?.createdAt ||
    chat?.updatedAt ||
    new Date().toISOString()
  );
};

const normalizeCachedEntry = (entry = {}) => {
  const chatId = normalizeId(entry?.chatId || entry?._id);
  if (!chatId) return null;

  return {
    ...entry,
    _id: normalizeId(entry?._id) || chatId,
    chatId,
    otherUser: entry?.otherUser || entry?.peerUser || {},
    peerUser: entry?.peerUser || entry?.otherUser || {},
    participants: Array.isArray(entry?.participants) ? entry.participants : [],
    lastMessage: entry?.lastMessage || {},
    unreadCount: Number(entry?.unreadCount || 0),
    isPinned: Boolean(entry?.isPinned),
    isMuted: Boolean(entry?.isMuted),
    isArchived: Boolean(entry?.isArchived),
    pinnedAt: entry?.pinnedAt || null,
    muteUntil: entry?.muteUntil || null,
    timestamp: getChatTimestampIso(entry),
    lastMessageAt: entry?.lastMessageAt || getChatTimestampIso(entry),
  };
};

const buildStorageChatList = (state) => {
  return Object.keys(state?.chatMap || {}).map((chatId) => {
    const chat = state.chatMap[chatId] || {};
    return {
      chatId,
      participants: Array.isArray(chat?.participants) ? chat.participants : [],
      otherUser: chat?.otherUser || chat?.peerUser || {},
      peerUser: chat?.peerUser || chat?.otherUser || {},
      lastMessage: chat?.lastMessage || {},
      unreadCount: Number(state?.unreadByChat?.[chatId] || chat?.unreadCount || 0),
      isPinned: Boolean(chat?.isPinned),
      isMuted: Boolean(chat?.isMuted),
      isArchived: Boolean(chat?.isArchived),
      timestamp: getChatTimestampIso(chat),
      lastMessageAt: chat?.lastMessageAt || getChatTimestampIso(chat),
      pinnedAt: chat?.pinnedAt || null,
      muteUntil: chat?.muteUntil || null,
    };
  });
};

const recomputeTotalUnread = (unreadByChat) => {
  return Object.values(unreadByChat || {}).reduce((sum, count) => sum + Number(count || 0), 0);
};

const unwrapPayload = (payload = {}) => {
  return payload?.data || payload;
};

const normalizeMessagePayload = (payload = {}) => {
  const source = unwrapPayload(payload);
  const message = source?.message || source?.data || source;

  return {
    ...message,
    chatId: normalizeId(message?.chatId || message?.roomId || message?.chat || source?.chatId || source?.roomId || source?.chat),
    createdAt: message?.createdAt || message?.timestamp || source?.createdAt || new Date().toISOString(),
    senderId: normalizeId(message?.senderId || source?.senderId || source?.from || null),
    receiverId: normalizeId(message?.receiverId || source?.receiverId || source?.to || null),
    text: message?.text || message?.content || source?.text || source?.content || '',
    status: normalizeMessageDeliveryStatus(message?.status || source?.status || null),
    messageId: normalizeId(message?.messageId || message?._id || source?.messageId || source?._id || null),
    serverMessageId: normalizeId(message?.serverMessageId || message?.messageId || message?._id || source?.serverMessageId || source?.messageId || source?._id || null),
    tempId: normalizeId(message?.tempId || source?.tempId || null),
    id: normalizeId(message?.id || message?.messageId || message?._id || source?.id || source?.messageId || source?._id || null),
  };
};

const normalizePresencePayload = (payload = {}) => {
  const source = unwrapPayload(payload);
  const candidate = source?.presence || source?.userPresence || source?.presenceData || source?.user || source;
  const userId = normalizeId(source?.userId || candidate?.userId || candidate?.id || null);
  return { userId, presence: candidate };
};

const normalizeTypingPayload = (payload = {}) => {
  const source = unwrapPayload(payload);
  return {
    chatId: normalizeId(source?.chatId || source?.roomId || source?.chat || null),
    userId: normalizeId(source?.senderId || source?.userId || source?.from || null),
    messageType: source?.messageType || null,
  };
};

const reducer = (state, action) => {
  switch (action.type) {
    case 'RESET_STATE': {
      return {
        ...initialState,
        currentUserId: action.payload?.currentUserId || null,
      };
    }

    case 'SET_CURRENT_USER': {
      return { ...state, currentUserId: action.payload || null };
    }

    case 'HYDRATE_CHATS': {
      const incoming = Array.isArray(action.payload) ? action.payload : [];
      const nextMap = { ...state.chatMap };
      const migratedUnreadPairs = [];

      incoming.forEach((chat) => {
        const normalizedChatId = normalizeId(chat?.chatId || chat?._id);
        const peerUserId = getPeerUserId(chat);
        const aliasChatId = findChatIdByPeer(nextMap, peerUserId, normalizedChatId);
        const chatId = normalizedChatId || aliasChatId;
        if (!chatId) return;

        const aliasExisting = aliasChatId && aliasChatId !== chatId ? nextMap[aliasChatId] : null;
        const prev = {
          ...(aliasExisting || {}),
          ...(nextMap[chatId] || {}),
        };

        if (aliasChatId && aliasChatId !== chatId) {
          delete nextMap[aliasChatId];
          migratedUnreadPairs.push([aliasChatId, chatId]);
        }

        const prevUnread = state.unreadByChat[chatId];
        const unreadCount = typeof prevUnread === 'number' ? prevUnread : Number(chat?.unreadCount || 0);
        const normalizedPeerUser = {
          ...(prev?.peerUser || {}),
          ...(chat?.peerUser || {}),
          _id: normalizeId(chat?.peerUser?._id || chat?.peerUser?.userId || chat?.peerUser?.id || prev?.peerUser?._id || prev?.peerUser?.userId || prev?.peerUser?.id || peerUserId),
        };

        nextMap[chatId] = {
          ...prev,
          ...chat,
          _id: normalizeId(chat?._id) || chatId,
          chatId,
          peerUser: normalizedPeerUser,
          unreadCount,
          lastMessageAt: chat?.lastMessageAt || prev?.lastMessageAt || chat?.lastMessage?.createdAt || prev?.lastMessage?.createdAt,
        };
      });

      const sections = buildOrderedSections(nextMap);
      const unreadByChat = { ...state.unreadByChat };
      migratedUnreadPairs.forEach(([fromId, toId]) => {
        if (typeof unreadByChat[toId] !== 'number' && typeof unreadByChat[fromId] === 'number') {
          unreadByChat[toId] = unreadByChat[fromId];
        }
        delete unreadByChat[fromId];
      });

      Object.keys(nextMap).forEach((id) => {
        if (typeof unreadByChat[id] !== 'number') {
          unreadByChat[id] = Number(nextMap[id]?.unreadCount || 0);
        }
      });

      Object.keys(unreadByChat).forEach((id) => {
        if (!nextMap[id]) {
          delete unreadByChat[id];
        }
      });

      Object.keys(nextMap).forEach((id) => {
        nextMap[id] = {
          ...nextMap[id],
          unreadCount: Number(unreadByChat[id] || 0),
        };
      });

      return {
        ...state,
        chatMap: nextMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        unreadByChat,
        totalUnread: recomputeTotalUnread(unreadByChat),
        hasHydratedCache: true,
      };
    }

    case 'HYDRATE_CHAT_CACHE': {
      const incoming = Array.isArray(action.payload) ? action.payload : [];
      if (incoming.length === 0) {
        return {
          ...state,
          hasHydratedCache: true,
        };
      }

      const nextMap = { ...state.chatMap };
      const unreadByChat = { ...state.unreadByChat };

      incoming.forEach((rawChat) => {
        const chat = normalizeCachedEntry(rawChat);
        if (!chat) return;
        const existing = nextMap[chat.chatId] || {};

        nextMap[chat.chatId] = {
          ...chat,
          ...existing,
          ...chat,
          chatId: chat.chatId,
          _id: normalizeId(chat?._id) || chat.chatId,
          peerUser: {
            ...(existing?.peerUser || {}),
            ...(chat?.peerUser || {}),
          },
          otherUser: {
            ...(existing?.otherUser || {}),
            ...(chat?.otherUser || chat?.peerUser || {}),
          },
          unreadCount: Number(chat?.unreadCount || 0),
          timestamp: chat?.timestamp || getChatTimestampIso(chat),
          lastMessageAt: chat?.lastMessageAt || chat?.timestamp || getChatTimestampIso(chat),
        };

        unreadByChat[chat.chatId] = Number(chat?.unreadCount || 0);
      });

      const sections = buildOrderedSections(nextMap);
      return {
        ...state,
        chatMap: nextMap,
        unreadByChat,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        totalUnread: recomputeTotalUnread(unreadByChat),
        hasHydratedCache: true,
      };
    }

    case 'APPLY_OPTIMISTIC_CHAT_ACTION': {
      const payload = action.payload || {};
      const chatId = normalizeId(payload.chatId);
      if (!chatId) return state;

      const existing = state.chatMap[chatId] || { _id: chatId, chatId };
      const unreadByChat = { ...state.unreadByChat };
      const nextMap = {
        ...state.chatMap,
        [chatId]: {
          ...existing,
          ...payload.patch,
          chatId,
          _id: normalizeId(existing._id) || chatId,
          timestamp: payload.patch?.timestamp || existing?.timestamp || getChatTimestampIso(existing),
          lastMessageAt: payload.patch?.lastMessageAt || existing?.lastMessageAt || getChatTimestampIso(existing),
          unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
        },
      };

      const sections = buildOrderedSections(nextMap);

      return {
        ...state,
        chatMap: nextMap,
        unreadByChat,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
      };
    }

    case 'SET_ACTIVE_CHAT': {
      const chatId = action.payload || null;
      const unreadByChat = { ...state.unreadByChat };
      if (chatId && unreadByChat[chatId] > 0) {
        unreadByChat[chatId] = 0;
      }

      const chatMap = { ...state.chatMap };
      if (chatId && chatMap[chatId]) {
        chatMap[chatId] = {
          ...chatMap[chatId],
          unreadCount: 0,
        };
      }

      const sections = buildOrderedSections(chatMap);

      return {
        ...state,
        activeChatId: chatId,
        unreadByChat,
        chatMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        totalUnread: recomputeTotalUnread(unreadByChat),
      };
    }

    case 'INCOMING_MESSAGE': {
      const message = action.payload || {};
      const chatId = normalizeId(message.chatId || message.roomId || message.chat);
      if (!chatId) return state;

      const senderId = normalizeId(message.senderId);
      const receiverId = normalizeId(message.receiverId);
      const peerUserId = senderId && state.currentUserId && senderId === String(state.currentUserId)
        ? receiverId
        : senderId;

      const aliasChatId = findChatIdByPeer(state.chatMap, peerUserId, chatId);

      const existing = state.chatMap[chatId] || (aliasChatId ? state.chatMap[aliasChatId] : null) || {
        _id: chatId,
        chatId,
      };

      const lastMessageAt = message.createdAt || new Date().toISOString();
      const lastMessage = {
        ...(existing.lastMessage || {}),
        id: message.id || message.messageId || existing?.lastMessage?.id || null,
        messageId: message.messageId || message.id || existing?.lastMessage?.messageId || null,
        serverMessageId: message.serverMessageId || message.messageId || message.id || existing?.lastMessage?.serverMessageId || null,
        tempId: message.tempId || existing?.lastMessage?.tempId || null,
        text: message.text || message.content || existing?.lastMessage?.text || '',
        createdAt: lastMessageAt,
        senderId: message.senderId,
        status: pickHighestMessageStatus(existing?.lastMessage?.status, message.status),
      };

      const isIncoming = Boolean(
        senderId &&
        state.currentUserId &&
        String(senderId) !== String(state.currentUserId)
      );

      const unreadByChat = { ...state.unreadByChat };
      if (isIncoming && state.activeChatId !== chatId) {
        unreadByChat[chatId] = Number(unreadByChat[chatId] || existing.unreadCount || 0) + 1;
      }

      const nextMap = {
        ...state.chatMap,
        [chatId]: {
          ...existing,
          chatId,
          _id: normalizeId(existing._id) || chatId,
          lastMessage,
          lastMessageAt,
          unreadCount: Number(unreadByChat[chatId] || 0),
        },
      };

      if (aliasChatId && aliasChatId !== chatId) {
        delete nextMap[aliasChatId];
        delete unreadByChat[aliasChatId];
      }

      const sections = buildOrderedSections(nextMap);

      Object.keys(nextMap).forEach((id) => {
        nextMap[id] = {
          ...nextMap[id],
          unreadCount: Number(unreadByChat[id] || 0),
        };
      });

      return {
        ...state,
        chatMap: nextMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        unreadByChat,
        highlightByChat: {
          ...state.highlightByChat,
          ...(existing?.isMuted ? {} : { [chatId]: Date.now() }),
        },
        totalUnread: recomputeTotalUnread(unreadByChat),
      };
    }

    case 'OUTGOING_MESSAGE': {
      const message = action.payload || {};
      const chatId = normalizeId(message.chatId);
      if (!chatId) return state;

      const existing = state.chatMap[chatId] || { _id: chatId, chatId };
      const lastMessageAt = message.createdAt || new Date().toISOString();
      const lastMessage = {
        ...(existing.lastMessage || {}),
        id: message.id || message.messageId || existing?.lastMessage?.id || null,
        messageId: message.messageId || message.id || existing?.lastMessage?.messageId || null,
        serverMessageId: message.serverMessageId || message.messageId || message.id || existing?.lastMessage?.serverMessageId || null,
        tempId: message.tempId || existing?.lastMessage?.tempId || null,
        text: message.text || existing?.lastMessage?.text || '',
        createdAt: lastMessageAt,
        senderId: message.senderId,
        status: pickHighestMessageStatus(existing?.lastMessage?.status, message.status || 'sent'),
      };

      const nextMap = {
        ...state.chatMap,
        [chatId]: {
          ...existing,
          chatId,
          _id: normalizeId(existing._id) || chatId,
          peerUser: message?.peerUser ? { ...(existing?.peerUser || {}), ...message.peerUser } : existing?.peerUser,
          lastMessage,
          lastMessageAt,
        },
      };

      const sections = buildOrderedSections(nextMap);
      return {
        ...state,
        chatMap: nextMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
      };
    }

    case 'LOCAL_LAST_MESSAGE_OVERRIDE': {
      const payload = action.payload || {};
      const chatId = normalizeId(payload.chatId);
      if (!chatId) return state;

      const existing = state.chatMap[chatId] || { _id: chatId, chatId };
      const nextMap = {
        ...state.chatMap,
        [chatId]: {
          ...existing,
          chatId,
          _id: normalizeId(existing._id) || chatId,
          lastMessage: payload.lastMessage || existing.lastMessage || { text: 'No messages yet', type: 'text' },
          lastMessageType: payload.lastMessageType || payload.lastMessage?.type || existing.lastMessageType || 'text',
          lastMessageSender: payload.lastMessageSender ?? payload.lastMessage?.senderId ?? existing.lastMessageSender ?? null,
          lastMessageAt: payload.lastMessageAt || payload.lastMessage?.createdAt || existing.lastMessageAt || null,
        },
      };

      const sections = buildOrderedSections(nextMap);
      return {
        ...state,
        chatMap: nextMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
      };
    }

    case 'MARK_READ': {
      const chatId = normalizeId(action.payload);
      if (!chatId) return state;

      const unreadByChat = { ...state.unreadByChat, [chatId]: 0 };
      const chatMap = { ...state.chatMap };
      if (chatMap[chatId]) {
        chatMap[chatId] = { ...chatMap[chatId], unreadCount: 0 };
      }

      const sections = buildOrderedSections(chatMap);

      return {
        ...state,
        unreadByChat,
        chatMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        totalUnread: recomputeTotalUnread(unreadByChat),
      };
    }

    case 'UPDATE_LAST_MESSAGE_STATUS': {
      const { chatId: rawChatId, status, messageId: rawMessageId } = action.payload || {};
      const chatId = normalizeId(rawChatId);
      const messageId = normalizeId(rawMessageId);
      const normalizedIncomingStatus = normalizeMessageDeliveryStatus(status);
      if (!chatId || !normalizedIncomingStatus || !state.chatMap[chatId]) return state;

      const chatMap = { ...state.chatMap };
      const existing = chatMap[chatId];

      const existingLastMessage = existing?.lastMessage || null;
      const lastMessageId = getMessageIdentifier(existingLastMessage);
      if (messageId && lastMessageId && messageId !== lastMessageId) {
        return state;
      }

      const currentStatus = normalizeMessageDeliveryStatus(existing?.lastMessageStatus || existingLastMessage?.status);
      const nextStatus = pickHighestMessageStatus(currentStatus, normalizedIncomingStatus);
      if (!nextStatus || nextStatus === currentStatus) {
        return state;
      }

      if (existingLastMessage) {
        chatMap[chatId] = {
          ...existing,
          lastMessageStatus: nextStatus,
          lastMessage: { ...existingLastMessage, status: nextStatus },
        };
      } else {
        chatMap[chatId] = { ...existing, lastMessageStatus: nextStatus };
      }
      return { ...state, chatMap };
    }

    case 'CLEAR_CHAT_HIGHLIGHT': {
      const chatId = action.payload;
      if (!chatId || !state.highlightByChat[chatId]) return state;
      const nextHighlight = { ...state.highlightByChat };
      delete nextHighlight[chatId];
      return {
        ...state,
        highlightByChat: nextHighlight,
      };
    }

    case 'APPLY_CHAT_LIST_UPDATES': {
      const updates = Array.isArray(action.payload) ? action.payload : [];
      if (updates.length === 0) return state;

      const nextMap = { ...state.chatMap };
      const unreadByChat = { ...state.unreadByChat };
      const typingStates = { ...state.typingStates };
      const presenceByUser = { ...state.presenceByUser };
      const highlightByChat = { ...state.highlightByChat };

      updates.forEach((rawUpdate) => {
        const update = normalizeChatListUpdate(rawUpdate);
        if (!update) return;

        const { chatId, type, item, timestamp } = update;
        const itemPeerUserId = getPeerUserId(item);
        const aliasChatId = findChatIdByPeer(nextMap, itemPeerUserId, chatId);
        let existing = nextMap[chatId] || { _id: chatId, chatId };

        if (aliasChatId && aliasChatId !== chatId && nextMap[aliasChatId]) {
          existing = { ...nextMap[aliasChatId], ...existing };
          delete nextMap[aliasChatId];
          if (typeof unreadByChat[chatId] !== 'number' && typeof unreadByChat[aliasChatId] === 'number') {
            unreadByChat[chatId] = unreadByChat[aliasChatId];
          }
          delete unreadByChat[aliasChatId];
          delete typingStates[aliasChatId];
          delete highlightByChat[aliasChatId];
        }

        const mergedPeerUser = {
          ...(existing?.peerUser || {}),
          ...(item?.peerUser || {}),
          _id: normalizeId(item?.peerUser?._id || item?.peerUser?.userId || item?.peerUser?.id || existing?.peerUser?._id || existing?.peerUser?.userId || existing?.peerUser?.id || itemPeerUserId),
        };

        const mergedBase = {
          ...existing,
          ...item,
          _id: normalizeId(item?._id) || normalizeId(existing?._id) || chatId,
          chatId,
          peerUser: mergedPeerUser,
        };

        if (typeof item?.unreadCount === 'number') {
          unreadByChat[chatId] = Number(item.unreadCount);
        }

        switch (type) {
          case 'new_message': {
            const lastMessage = buildLastMessageFromItem(existing, item, timestamp);
            const isActiveChat = state.activeChatId && String(state.activeChatId) === String(chatId);
            const currentUnread = Number(unreadByChat[chatId] || existing?.unreadCount || 0);
            unreadByChat[chatId] = isActiveChat ? 0 : currentUnread + (typeof item?.unreadCount === 'number' ? 0 : 1);

            const nextLastMessageAt = isActiveChat
              ? (existing?.lastMessageAt || item?.lastMessageAt || lastMessage?.createdAt || timestamp)
              : (item?.lastMessageAt || lastMessage?.createdAt || timestamp);

            nextMap[chatId] = {
              ...mergedBase,
              isArchived: Boolean(mergedBase?.isArchived),
              lastMessage,
              lastMessageAt: nextLastMessageAt,
              timestamp: nextLastMessageAt,
              lastMessageStatus: pickHighestMessageStatus(mergedBase?.lastMessageStatus, lastMessage?.status) || 'sent',
              unreadCount: unreadByChat[chatId],
            };

            if (!Boolean(mergedBase?.isMuted)) {
              highlightByChat[chatId] = Date.now();
            }
            break;
          }

          case 'message_read': {
            unreadByChat[chatId] = 0;
            const nextStatus = pickHighestMessageStatus(existing?.lastMessage?.status, 'read') || 'read';
            const lastMessage = {
              ...(existing?.lastMessage || {}),
              status: nextStatus,
            };

            nextMap[chatId] = {
              ...mergedBase,
              lastMessage,
              lastMessageStatus: nextStatus,
              unreadCount: 0,
            };

            delete highlightByChat[chatId];
            break;
          }

          case 'message_delivered': {
            const nextStatus = pickHighestMessageStatus(existing?.lastMessage?.status, 'delivered') || 'delivered';
            const lastMessage = {
              ...(existing?.lastMessage || {}),
              status: nextStatus,
            };

            nextMap[chatId] = {
              ...mergedBase,
              lastMessage,
              lastMessageStatus: nextStatus,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'message_edited': {
            const lastMessage = {
              ...(existing?.lastMessage || {}),
              text: item?.lastMessage || item?.text || existing?.lastMessage?.text || '',
              type: item?.lastMessageType || existing?.lastMessage?.type || 'text',
              senderId: item?.lastMessageSender || existing?.lastMessage?.senderId || existing?.lastMessageSender || null,
              createdAt: item?.lastMessageAt || existing?.lastMessage?.createdAt || existing?.lastMessageAt || timestamp,
              isEdited: true,
              editedAt: item?.editedAt || timestamp,
            };

            nextMap[chatId] = {
              ...mergedBase,
              lastMessage,
              lastMessageType: lastMessage.type,
              lastMessageSender: lastMessage.senderId,
              lastMessageAt: item?.lastMessageAt || existing?.lastMessageAt || timestamp,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
              lastMessageEdited: true,
            };
            break;
          }

          case 'message_deleted': {
            const lastMessage = {
              ...(existing?.lastMessage || {}),
              text: 'Message deleted',
              type: 'text',
              senderId: item?.lastMessageSender || existing?.lastMessage?.senderId || existing?.lastMessageSender || null,
              createdAt: item?.lastMessageAt || existing?.lastMessageAt || timestamp,
              status: existing?.lastMessage?.status || null,
              isDeleted: true,
            };

            nextMap[chatId] = {
              ...mergedBase,
              lastMessage,
              lastMessageType: 'text',
              lastMessageSender: lastMessage.senderId,
              lastMessageAt: item?.lastMessageAt || existing?.lastMessageAt || timestamp,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_created': {
            const lastMessage = buildLastMessageFromItem(existing, item, timestamp);
            nextMap[chatId] = {
              ...mergedBase,
              chatType: mergedBase?.chatType || 'private',
              unreadCount: Number(unreadByChat[chatId] || 0),
              lastMessage: {
                ...lastMessage,
                text: lastMessage?.text || 'Start conversation',
              },
              lastMessageAt: item?.lastMessageAt || timestamp,
            };
            break;
          }

          case 'chat_archived': {
            nextMap[chatId] = {
              ...mergedBase,
              isArchived: true,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_unarchived': {
            nextMap[chatId] = {
              ...mergedBase,
              isArchived: false,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_pinned': {
            nextMap[chatId] = {
              ...mergedBase,
              isPinned: true,
              pinnedAt: item?.pinnedAt || timestamp,
              timestamp: item?.lastMessageAt || existing?.lastMessageAt || existing?.timestamp || timestamp,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_unpinned': {
            nextMap[chatId] = {
              ...mergedBase,
              isPinned: false,
              pinnedAt: null,
              timestamp: item?.lastMessageAt || existing?.lastMessageAt || existing?.timestamp || timestamp,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_muted': {
            nextMap[chatId] = {
              ...mergedBase,
              isMuted: true,
              muteUntil: item?.muteUntil || existing?.muteUntil || null,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_unmuted': {
            nextMap[chatId] = {
              ...mergedBase,
              isMuted: false,
              muteUntil: null,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_cleared': {
            unreadByChat[chatId] = 0;
            nextMap[chatId] = {
              ...mergedBase,
              lastMessage: {
                text: item?.lastMessage?.text || 'No messages yet',
                type: 'text',
                senderId: null,
                status: null,
                createdAt: null,
                isDeleted: false,
              },
              lastMessageAt: null,
              lastMessageType: 'text',
              lastMessageSender: null,
              unreadCount: 0,
            };
            delete highlightByChat[chatId];
            break;
          }

          case 'typing_start': {
            typingStates[chatId] = {
              isTyping: true,
              userId: item?.senderId || item?.userId || existing?.peerUser?._id || typingStates[chatId]?.userId || null,
              messageType: item?.messageType || null,
              typingText: item?.typingText || 'Typing...',
              startedAt: Date.now(),
            };
            nextMap[chatId] = {
              ...mergedBase,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'typing_stop': {
            delete typingStates[chatId];
            nextMap[chatId] = {
              ...mergedBase,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'presence_update': {
            const peerUserId =
              item?.participantId ||
              item?.userId ||
              existing?.peerUser?._id ||
              mergedBase?.peerUser?._id ||
              null;

            if (peerUserId) {
              presenceByUser[peerUserId] = {
                ...(presenceByUser[peerUserId] || {}),
                status: normalizeStatus(item?.participantPresence || item?.status || item?.presenceStatus),
                lastSeen: item?.participantLastSeen || item?.lastSeen || null,
                lastSeenDisplay: formatLastSeen(item?.participantLastSeen || item?.lastSeen || null),
                updatedAt: Date.now(),
              };
            }

            nextMap[chatId] = {
              ...mergedBase,
              participantPresence: item?.participantPresence || mergedBase?.participantPresence || existing?.participantPresence || 'offline',
              participantLastSeen: item?.participantLastSeen || mergedBase?.participantLastSeen || existing?.participantLastSeen || null,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          default: {
            nextMap[chatId] = {
              ...mergedBase,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }
        }
      });

      Object.keys(nextMap).forEach((id) => {
        if (typeof unreadByChat[id] !== 'number') {
          unreadByChat[id] = Number(nextMap[id]?.unreadCount || 0);
        }

        nextMap[id] = {
          ...nextMap[id],
          unreadCount: Number(unreadByChat[id] || 0),
        };
      });

      const sections = buildOrderedSections(nextMap);

      return {
        ...state,
        chatMap: nextMap,
        unreadByChat,
        typingStates,
        presenceByUser,
        highlightByChat,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        totalUnread: recomputeTotalUnread(unreadByChat),
      };
    }

    case 'PRESENCE_UPDATE': {
      const { userId, presence } = action.payload || {};
      if (!userId) return state;

      const nextPresence = {
        status: normalizeStatus(
          presence?.status ||
          presence?.presenceStatus ||
          presence?.effectiveStatus ||
          presence?.manualStatus
        ),
        lastSeen: presence?.lastSeen || presence?.last_seen || null,
        customStatus: presence?.customStatus || presence?.manualCustomStatus || null,
        updatedAt: presence?.updatedAt || presence?.lastUpdated || Date.now(),
      };

      return {
        ...state,
        presenceByUser: {
          ...state.presenceByUser,
          [userId]: {
            ...(state.presenceByUser[userId] || {}),
            ...nextPresence,
          },
        },
      };
    }

    case 'TYPING_START': {
      const { chatId, userId, messageType } = action.payload || {};
      if (!chatId || !userId) return state;
      return {
        ...state,
        typingStates: {
          ...state.typingStates,
          [chatId]: {
            isTyping: true,
            userId,
            messageType: messageType || null,
            startedAt: Date.now(),
          },
        },
      };
    }

    case 'TYPING_STOP': {
      const chatId = action.payload?.chatId;
      if (!chatId || !state.typingStates[chatId]) return state;
      const next = { ...state.typingStates };
      delete next[chatId];
      return {
        ...state,
        typingStates: next,
      };
    }

    default:
      return state;
  }
};

const RealtimeChatContext = createContext(null);

export function RealtimeChatProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const typingTimersRef = useRef({});
  const chatHighlightTimersRef = useRef({});
  const chatListUpdateQueueRef = useRef([]);
  const chatListUpdateFlushRef = useRef(null);
  const storageSaveTimerRef = useRef(null);
  const socketUnsubscribersRef = useRef([]);
  const attachedSocketRef = useRef(null);

  const clearTypingTimer = useCallback((chatId) => {
    const timer = typingTimersRef.current[chatId];
    if (timer) {
      clearTimeout(timer);
      delete typingTimersRef.current[chatId];
    }
  }, []);

  const handleTypingStart = useCallback((payload) => {
    const normalized = normalizeTypingPayload(payload);
    const chatId = normalized.chatId;
    const userId = normalized.userId;
    if (!chatId || !userId) return;

    dispatch({ type: 'TYPING_START', payload: { chatId, userId, messageType: normalized.messageType } });

    clearTypingTimer(chatId);
    typingTimersRef.current[chatId] = setTimeout(() => {
      dispatch({ type: 'TYPING_STOP', payload: { chatId } });
      clearTypingTimer(chatId);
    }, TYPING_TTL);
  }, [clearTypingTimer]);

  const handleTypingStop = useCallback((payload) => {
    const normalized = normalizeTypingPayload(payload);
    const chatId = normalized.chatId;
    if (!chatId) return;
    clearTypingTimer(chatId);
    dispatch({ type: 'TYPING_STOP', payload: { chatId } });
  }, [clearTypingTimer]);

  const handlePresenceUpdate = useCallback((payload) => {
    const normalized = normalizePresencePayload(payload);
    const userId = normalized.userId;
    if (!userId) return;
    dispatch({ type: 'PRESENCE_UPDATE', payload: { userId, presence: normalized.presence } });
  }, []);

  const subscribePresenceForChats = useCallback((chatMap) => {
    const socket = getSocket();
    if (!socket || !isSocketConnected()) return;

    const userIds = Object.values(chatMap || {})
      .map((chat) => chat?.peerUser?._id)
      .filter(Boolean);

    const uniqueUserIds = Array.from(new Set(userIds));
    if (uniqueUserIds.length === 0) return;

    socket.emit('presence:subscribe', { userIds: uniqueUserIds });
    socket.emit('presence:fetch', { userIds: uniqueUserIds, detailed: true });
  }, []);

  const detachSocketListeners = useCallback(() => {
    socketUnsubscribersRef.current.forEach((off) => {
      if (typeof off === 'function') off();
    });
    socketUnsubscribersRef.current = [];
    attachedSocketRef.current = null;
  }, []);

  const attachSocketListeners = useCallback(() => {
    const socket = getSocket();
    if (!socket) return false;
    if (attachedSocketRef.current === socket && socketUnsubscribersRef.current.length > 0) {
      return true;
    }

    if (attachedSocketRef.current && attachedSocketRef.current !== socket) {
      detachSocketListeners();
    }

    const onMessage = (payload) => {
      const normalized = normalizeMessagePayload(payload);
      dispatch({ type: 'INCOMING_MESSAGE', payload: normalized });
    };

    const dispatchLastMessageStatusUpdate = (payload, fallbackStatus) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.roomId || source?.chat || source?.data?.chatId || null);
      const messageId = normalizeId(source?.messageId || source?._id || source?.data?.messageId || source?.data?._id || null);
      const status = normalizeMessageDeliveryStatus(source?.status || fallbackStatus);
      if (!chatId || !status) return;

      dispatch({
        type: 'UPDATE_LAST_MESSAGE_STATUS',
        payload: { chatId, status, messageId },
      });
    };

    const onMessageRead = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.roomId || source?.chat || null);
      if (chatId) dispatch({ type: 'MARK_READ', payload: chatId });
      dispatchLastMessageStatusUpdate(payload, 'read');
    };
    const onMessageDelivered = (payload) => dispatchLastMessageStatusUpdate(payload, 'delivered');
    const onMessageReadBulk = (payload) => dispatchLastMessageStatusUpdate(payload, 'read');
    const onMessageReadBulkResponse = (payload) => dispatchLastMessageStatusUpdate(payload, 'read');
    const onMessageReadResponse = (payload) => dispatchLastMessageStatusUpdate(payload, 'read');
    const onMessageSeen = (payload) => dispatchLastMessageStatusUpdate(payload, 'read');
    const onPresence = (payload) => handlePresenceUpdate(payload);
    const onOnline = (payload) => handlePresenceUpdate({ ...payload, status: 'online' });
    const onOffline = (payload) => handlePresenceUpdate({ ...payload, status: 'offline' });
    const onTypingStartSocket = (payload) => handleTypingStart(payload);
    const onTypingStopSocket = (payload) => handleTypingStop(payload);
    const onPresenceFetchResponse = (payload) => {
      const source = unwrapPayload(payload);
      const rows = source?.users || source?.presence || source || [];
      if (!Array.isArray(rows)) return;
      rows.forEach((row) => handlePresenceUpdate(row));
    };
    const onTypingIndicator = (payload) => {
      const source = unwrapPayload(payload);
      if (!source?.chatId) return;

      if (source?.isTyping) {
        handleTypingStart({
          chatId: source.chatId,
          userId: source.userId,
          messageType: source.messageType,
        });
      } else {
        handleTypingStop({
          chatId: source.chatId,
        });
      }
    };
    const flushChatListUpdates = () => {
      if (chatListUpdateFlushRef.current) {
        clearTimeout(chatListUpdateFlushRef.current);
        chatListUpdateFlushRef.current = null;
      }

      const queued = chatListUpdateQueueRef.current;
      if (!Array.isArray(queued) || queued.length === 0) return;
      chatListUpdateQueueRef.current = [];

      try {
        dispatch({ type: 'APPLY_CHAT_LIST_UPDATES', payload: queued });

        queued.forEach((rawUpdate) => {
          const normalized = normalizeChatListUpdate(rawUpdate);
          if (!normalized) return;

          const { chatId, type } = normalized;
          if (type === 'typing_start') {
            clearTypingTimer(chatId);
            typingTimersRef.current[chatId] = setTimeout(() => {
              dispatch({ type: 'TYPING_STOP', payload: { chatId } });
              clearTypingTimer(chatId);
            }, TYPING_TTL);
          }

          if (type === 'new_message') {
            const existingTimer = chatHighlightTimersRef.current[chatId];
            if (existingTimer) {
              clearTimeout(existingTimer);
            }

            chatHighlightTimersRef.current[chatId] = setTimeout(() => {
              dispatch({ type: 'CLEAR_CHAT_HIGHLIGHT', payload: chatId });
              delete chatHighlightTimersRef.current[chatId];
            }, CHAT_HIGHLIGHT_TTL);
          }
        });
      } catch (error) {
        console.warn('chat:list:update flush failed', error);
      }
    };

    const onChatListUpdate = (payload) => {
      chatListUpdateQueueRef.current.push(payload);

      if (chatListUpdateFlushRef.current) {
        return;
      }

      chatListUpdateFlushRef.current = setTimeout(() => {
        flushChatListUpdates();
      }, CHAT_UPDATE_BATCH_WINDOW);
    };

    const onChatInfoResponse = (payload) => {
      const source = unwrapPayload(payload);
      const item = source?.item || source?.chat || source?.data || source;
      const chatId = normalizeId(source?.chatId || item?.chatId || item?._id);
      if (!chatId) return;
      onChatListUpdate({
        type: 'chat_info',
        reason: 'chat:info:response',
        chatId,
        item: {
          ...item,
          chatId,
          timestamp: item?.timestamp || getChatTimestampIso(item),
        },
      });
    };

    const onChatPinResponse = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.data?.chatId);
      if (!chatId) return;
      onChatListUpdate({
        type: 'chat_pinned',
        reason: 'chat:pin:response',
        chatId,
        item: {
          chatId,
          isPinned: true,
          pinnedAt: source?.pinnedAt || source?.data?.pinnedAt || new Date().toISOString(),
          timestamp: source?.timestamp || Date.now(),
        },
      });
    };

    const onChatUnpinResponse = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.data?.chatId);
      if (!chatId) return;
      onChatListUpdate({
        type: 'chat_unpinned',
        reason: 'chat:unpin:response',
        chatId,
        item: {
          chatId,
          isPinned: false,
          pinnedAt: null,
          timestamp: source?.timestamp || Date.now(),
        },
      });
    };

    const onChatMuteResponse = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.data?.chatId);
      if (!chatId) return;
      onChatListUpdate({
        type: 'chat_muted',
        reason: 'chat:mute:response',
        chatId,
        item: {
          chatId,
          isMuted: true,
          muteUntil: source?.muteUntil || source?.data?.muteUntil || null,
        },
      });
    };

    const onChatUnmuteResponse = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.data?.chatId);
      if (!chatId) return;
      onChatListUpdate({
        type: 'chat_unmuted',
        reason: 'chat:unmute:response',
        chatId,
        item: {
          chatId,
          isMuted: false,
          muteUntil: null,
        },
      });
    };

    const onChatArchiveResponse = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.data?.chatId);
      if (!chatId) return;
      onChatListUpdate({
        type: 'chat_archived',
        reason: 'chat:archive:response',
        chatId,
        item: {
          chatId,
          isArchived: true,
        },
      });
    };

    const onChatUnarchiveResponse = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.data?.chatId);
      if (!chatId) return;
      onChatListUpdate({
        type: 'chat_unarchived',
        reason: 'chat:unarchive:response',
        chatId,
        item: {
          chatId,
          isArchived: false,
        },
      });
    };

    const onChatCleared = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.data?.chatId || source?.chat || source?.roomId);
      if (!chatId) return;

      onChatListUpdate({
        type: 'chat_cleared',
        reason: 'chat:cleared',
        chatId,
        item: {
          chatId,
          unreadCount: 0,
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
        },
      });
    };

    // Handle message:delivered:response — update last message status in chat list
    const onMessageDeliveredResponse = (payload) => {
      dispatchLastMessageStatusUpdate(payload, 'delivered');
    };

    // Handle message:read:all:response — mark chat as fully read in list
    const onMessageReadAllResponse = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.roomId || source?.chat);
      if (chatId) {
        dispatch({ type: 'MARK_READ', payload: chatId });
      }
      dispatchLastMessageStatusUpdate(payload, 'read');
    };

    // Handle message:seen:response — update last message seen status
    const onMessageSeenResponse = (payload) => {
      dispatchLastMessageStatusUpdate(payload, 'read');
    };

    socket.on('message:new', onMessage);
    socket.on('message:received', onMessage);
    socket.on('message:delivered', onMessageDelivered);
    socket.on('message:seen', onMessageSeen);
    socket.on('message:read', onMessageRead);
    socket.on('message:read:response', onMessageReadResponse);
    socket.on('message:read:bulk', onMessageReadBulk);
    socket.on('message:read:bulk:response', onMessageReadBulkResponse);
    socket.on('message:read:all', onMessageReadAllResponse);
    socket.on('message:delivered:response', onMessageDeliveredResponse);
    socket.on('message:read:all:response', onMessageReadAllResponse);
    socket.on('message:seen:response', onMessageSeenResponse);

    socket.on('presence:update', onPresence);
    socket.on('presence:subscribed:update', onPresence);
    socket.on('presence:get:response', onPresence);
    socket.on('presence:fetch:response', onPresenceFetchResponse);
    socket.on('user:online', onOnline);
    socket.on('user:offline', onOffline);

    socket.on('typing:start', onTypingStartSocket);
    socket.on('typing:stop', onTypingStopSocket);
    socket.on('typing:indicator', onTypingIndicator);
    socket.on('chat:list:update', onChatListUpdate);
    socket.on('chat:info:response', onChatInfoResponse);
    socket.on('chat:pin:response', onChatPinResponse);
    socket.on('chat:unpin:response', onChatUnpinResponse);
    socket.on('chat:mute:response', onChatMuteResponse);
    socket.on('chat:unmute:response', onChatUnmuteResponse);
    socket.on('chat:archive:response', onChatArchiveResponse);
    socket.on('chat:unarchive:response', onChatUnarchiveResponse);
    socket.on('chat:cleared:me', onChatCleared);
    socket.on('chat:cleared:everyone', onChatCleared);

    socketUnsubscribersRef.current = [
      () => socket.off('message:new', onMessage),
      () => socket.off('message:received', onMessage),
      () => socket.off('message:delivered', onMessageDelivered),
      () => socket.off('message:seen', onMessageSeen),
      () => socket.off('message:read', onMessageRead),
      () => socket.off('message:read:response', onMessageReadResponse),
      () => socket.off('message:read:bulk', onMessageReadBulk),
      () => socket.off('message:read:bulk:response', onMessageReadBulkResponse),
      () => socket.off('message:read:all', onMessageReadAllResponse),
      () => socket.off('message:delivered:response', onMessageDeliveredResponse),
      () => socket.off('message:read:all:response', onMessageReadAllResponse),
      () => socket.off('message:seen:response', onMessageSeenResponse),
      () => socket.off('presence:update', onPresence),
      () => socket.off('presence:subscribed:update', onPresence),
      () => socket.off('presence:get:response', onPresence),
      () => socket.off('presence:fetch:response', onPresenceFetchResponse),
      () => socket.off('user:online', onOnline),
      () => socket.off('user:offline', onOffline),
      () => socket.off('typing:start', onTypingStartSocket),
      () => socket.off('typing:stop', onTypingStopSocket),
      () => socket.off('typing:indicator', onTypingIndicator),
      () => socket.off('chat:list:update', onChatListUpdate),
      () => socket.off('chat:info:response', onChatInfoResponse),
      () => socket.off('chat:pin:response', onChatPinResponse),
      () => socket.off('chat:unpin:response', onChatUnpinResponse),
      () => socket.off('chat:mute:response', onChatMuteResponse),
      () => socket.off('chat:unmute:response', onChatUnmuteResponse),
      () => socket.off('chat:archive:response', onChatArchiveResponse),
      () => socket.off('chat:unarchive:response', onChatUnarchiveResponse),
      () => socket.off('chat:cleared:me', onChatCleared),
      () => socket.off('chat:cleared:everyone', onChatCleared),
    ];

    attachedSocketRef.current = socket;

    return true;
  }, [detachSocketListeners, handlePresenceUpdate, handleTypingStart, handleTypingStop]);

  useEffect(() => {
    let disposed = false;
    let intervalId = null;

    const tryAttach = () => {
      if (disposed) return;
      const attached = attachSocketListeners();
      if (attached && intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    tryAttach();
    intervalId = setInterval(tryAttach, 800);

    return () => {
      disposed = true;
      if (intervalId) clearInterval(intervalId);
      if (chatListUpdateFlushRef.current) {
        clearTimeout(chatListUpdateFlushRef.current);
        chatListUpdateFlushRef.current = null;
      }
      if (storageSaveTimerRef.current) {
        clearTimeout(storageSaveTimerRef.current);
        storageSaveTimerRef.current = null;
      }
      detachSocketListeners();
      Object.keys(typingTimersRef.current).forEach((chatId) => clearTypingTimer(chatId));
      Object.keys(chatHighlightTimersRef.current).forEach((chatId) => {
        clearTimeout(chatHighlightTimersRef.current[chatId]);
      });
      chatHighlightTimersRef.current = {};
    };
  }, [attachSocketListeners, clearTypingTimer, detachSocketListeners]);

  useEffect(() => {
    let cancelled = false;

    const loadCachedChatList = async () => {
      try {
        const raw = await AsyncStorage.getItem(CHAT_LIST_CACHE_KEY);
        if (!raw || cancelled) {
          dispatch({ type: 'HYDRATE_CHAT_CACHE', payload: [] });
          return;
        }

        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [];
        if (!cancelled) {
          dispatch({ type: 'HYDRATE_CHAT_CACHE', payload: list });
        }
      } catch {
        if (!cancelled) {
          dispatch({ type: 'HYDRATE_CHAT_CACHE', payload: [] });
        }
      }
    };

    loadCachedChatList();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!state.hasHydratedCache) return;

    if (storageSaveTimerRef.current) {
      clearTimeout(storageSaveTimerRef.current);
    }

    storageSaveTimerRef.current = setTimeout(async () => {
      try {
        const payload = buildStorageChatList(state);
        await AsyncStorage.setItem(CHAT_LIST_CACHE_KEY, JSON.stringify(payload));
      } catch {
        // noop
      }
    }, CHAT_LIST_SAVE_DEBOUNCE_MS);

    return () => {
      if (storageSaveTimerRef.current) {
        clearTimeout(storageSaveTimerRef.current);
        storageSaveTimerRef.current = null;
      }
    };
  }, [state]);

  useEffect(() => {
    const loadCurrentUser = async () => {
      try {
        const raw = await AsyncStorage.getItem('userInfo');
        if (!raw) return;
        const user = JSON.parse(raw);
        const userId = user?._id || user?.id || null;
        dispatch({ type: 'SET_CURRENT_USER', payload: userId });
      } catch {
        // noop
      }
    };
    loadCurrentUser();
  }, []);

  useEffect(() => {
    const unsubscribeReset = subscribeSessionReset(() => {
      dispatch({ type: 'RESET_STATE', payload: { currentUserId: null } });
    });

    const unsubscribeUserChanged = subscribeUserChanged(({ userId }) => {
      dispatch({ type: 'RESET_STATE', payload: { currentUserId: userId || null } });
    });

    return () => {
      unsubscribeReset();
      unsubscribeUserChanged();
    };
  }, []);

  const resetRealtimeState = useCallback(() => {
    dispatch({ type: 'RESET_STATE', payload: { currentUserId: state.currentUserId || null } });
  }, [state.currentUserId]);

  const hydrateChats = useCallback((chats) => {
    dispatch({ type: 'HYDRATE_CHATS', payload: chats || [] });
    const tempMap = {};
    (chats || []).forEach((chat) => {
      const chatId = normalizeId(chat?.chatId || chat?._id);
      if (chatId) tempMap[chatId] = chat;
    });
    subscribePresenceForChats(tempMap);
  }, [subscribePresenceForChats]);

  const deferDispatch = useCallback((action) => {
    // Guard against render-phase updates from consuming components.
    setTimeout(() => {
      dispatch(action);
    }, 0);
  }, []);

  const setActiveChat = useCallback(async (chatId) => {
    deferDispatch({ type: 'SET_ACTIVE_CHAT', payload: chatId || null });
    if (chatId) {
      const socket = getSocket();
      if (socket && isSocketConnected()) {
        try {
          const raw = await AsyncStorage.getItem('userInfo');
          const user = raw ? JSON.parse(raw) : null;
          const senderId = user?._id || user?.id;
          if (senderId) {
            // Use message:read:all to mark all messages in this chat as read
            socket.emit('message:read:all', { chatId, senderId });
          }
        } catch (e) {
          // Fallback without senderId
          socket.emit('message:read', { chatId });
        }
      }
    }
  }, [deferDispatch]);

  const markChatRead = useCallback((chatId) => {
    deferDispatch({ type: 'MARK_READ', payload: chatId });
  }, [deferDispatch]);

  const onLocalOutgoingMessage = useCallback((message) => {
    deferDispatch({ type: 'OUTGOING_MESSAGE', payload: message });
  }, [deferDispatch]);

  const updateLocalLastMessagePreview = useCallback((payload) => {
    deferDispatch({ type: 'LOCAL_LAST_MESSAGE_OVERRIDE', payload });
  }, [deferDispatch]);

  const applyOptimisticAction = useCallback((chatId, patch) => {
    deferDispatch({
      type: 'APPLY_OPTIMISTIC_CHAT_ACTION',
      payload: { chatId, patch },
    });
  }, [deferDispatch]);

  const emitChatAction = useCallback((event, payload = {}) => {
    const socket = getSocket();
    if (!socket || !isSocketConnected()) return;
    socket.emit(event, payload);
  }, []);

  const requestChatInfo = useCallback((chatId) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    emitChatAction('chat:info', { chatId: normalizedChatId });
  }, [emitChatAction]);

  const pinChat = useCallback((chatId) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    const nowIso = new Date().toISOString();
    applyOptimisticAction(normalizedChatId, {
      isPinned: true,
      pinnedAt: nowIso,
    });
    emitChatAction('chat:pin', { chatId: normalizedChatId });
  }, [applyOptimisticAction, emitChatAction]);

  const unpinChat = useCallback((chatId) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isPinned: false,
      pinnedAt: null,
    });
    emitChatAction('chat:unpin', { chatId: normalizedChatId });
  }, [applyOptimisticAction, emitChatAction]);

  const muteChat = useCallback((chatId, duration) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;

    const durationMs = Number(duration || 0);
    const muteUntil = durationMs > 0 ? new Date(Date.now() + durationMs).toISOString() : null;
    applyOptimisticAction(normalizedChatId, {
      isMuted: true,
      muteUntil,
    });
    emitChatAction('chat:mute', {
      chatId: normalizedChatId,
      duration: durationMs > 0 ? durationMs : undefined,
      muteUntil,
    });
  }, [applyOptimisticAction, emitChatAction]);

  const unmuteChat = useCallback((chatId) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isMuted: false,
      muteUntil: null,
    });
    emitChatAction('chat:unmute', { chatId: normalizedChatId });
  }, [applyOptimisticAction, emitChatAction]);

  const archiveChat = useCallback((chatId) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isArchived: true,
    });
    emitChatAction('chat:archive', { chatId: normalizedChatId });
  }, [applyOptimisticAction, emitChatAction]);

  const unarchiveChat = useCallback((chatId) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isArchived: false,
    });
    emitChatAction('chat:unarchive', { chatId: normalizedChatId });
  }, [applyOptimisticAction, emitChatAction]);

  const applyChatClearedPreview = useCallback((chatId, scope = 'me') => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;

    markChatRead(normalizedChatId);
    applyOptimisticAction(normalizedChatId, {
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
      unreadCount: 0,
    });
  }, [applyOptimisticAction, markChatRead]);

  const chatList = useMemo(() => {
    return state.sortedChatIds.map((chatId) => {
      const item = state.chatMap[chatId];
      const peerId = item?.peerUser?._id;
      const presence = peerId
        ? (state.presenceByUser[peerId] || {
            status: normalizeStatus(item?.participantPresence),
            lastSeen: item?.participantLastSeen || null,
            lastSeenDisplay: formatLastSeen(item?.participantLastSeen || null),
          })
        : null;
      const typing = state.typingStates[chatId] || null;
      const unreadCount = Number(state.unreadByChat[chatId] || item?.unreadCount || 0);
      const lastMessageDisplay = buildLastMessageDisplay({
        chat: item,
        currentUserId: state.currentUserId,
        isTyping: Boolean(typing?.isTyping),
      });

      return {
        ...item,
        otherUser: item?.otherUser || item?.peerUser || {},
        unreadCount,
        timestampDisplay: formatRelativeTime(item?.lastMessageAt),
        lastSeenDisplay: presence?.status === 'offline'
          ? (presence?.lastSeenDisplay || formatLastSeen(presence?.lastSeen || item?.participantLastSeen))
          : '',
        lastMessageDisplay,
        realtime: {
          presence,
          typing,
          isHighlighted: Boolean(state.highlightByChat[chatId]),
          highlightedAt: state.highlightByChat[chatId] || null,
        },
      };
    });
  }, [state.sortedChatIds, state.chatMap, state.presenceByUser, state.typingStates, state.unreadByChat, state.highlightByChat, state.currentUserId]);

  const archivedChatList = useMemo(() => {
    return state.archivedChatIds.map((chatId) => {
      const item = state.chatMap[chatId];
      const peerId = item?.peerUser?._id;
      const presence = peerId ? state.presenceByUser[peerId] : null;
      const typing = state.typingStates[chatId] || null;
      const unreadCount = Number(state.unreadByChat[chatId] || item?.unreadCount || 0);
      const lastMessageDisplay = buildLastMessageDisplay({
        chat: item,
        currentUserId: state.currentUserId,
        isTyping: Boolean(typing?.isTyping),
      });

      return {
        ...item,
        otherUser: item?.otherUser || item?.peerUser || {},
        unreadCount,
        timestampDisplay: formatRelativeTime(item?.lastMessageAt),
        lastSeenDisplay: presence?.status === 'offline'
          ? (presence?.lastSeenDisplay || formatLastSeen(presence?.lastSeen || item?.participantLastSeen))
          : '',
        lastMessageDisplay,
        realtime: {
          presence,
          typing,
          isHighlighted: Boolean(state.highlightByChat[chatId]),
          highlightedAt: state.highlightByChat[chatId] || null,
        },
      };
    });
  }, [state.archivedChatIds, state.chatMap, state.presenceByUser, state.typingStates, state.unreadByChat, state.highlightByChat, state.currentUserId]);

  const value = useMemo(() => ({
    state,
    chatList,
    archivedChatList,
    hydrateChats,
    setActiveChat,
    markChatRead,
    onLocalOutgoingMessage,
    updateLocalLastMessagePreview,
    resetRealtimeState,
    requestChatInfo,
    pinChat,
    unpinChat,
    muteChat,
    unmuteChat,
    archiveChat,
    unarchiveChat,
    applyChatClearedPreview,
  }), [
    state,
    chatList,
    archivedChatList,
    hydrateChats,
    setActiveChat,
    markChatRead,
    onLocalOutgoingMessage,
    updateLocalLastMessagePreview,
    resetRealtimeState,
    requestChatInfo,
    pinChat,
    unpinChat,
    muteChat,
    unmuteChat,
    archiveChat,
    unarchiveChat,
    applyChatClearedPreview,
  ]);

  return (
    <RealtimeChatContext.Provider value={value}>
      {children}
    </RealtimeChatContext.Provider>
  );
}

export const useRealtimeChat = () => {
  const context = useContext(RealtimeChatContext);
  if (!context) {
    throw new Error('useRealtimeChat must be used within RealtimeChatProvider');
  }
  return context;
};