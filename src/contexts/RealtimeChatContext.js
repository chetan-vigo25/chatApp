import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';
import { subscribeSessionReset, subscribeUserChanged } from '../services/sessionEvents';
import ChatDatabase from '../services/ChatDatabase';
import ChatCache from '../services/ChatCache';

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
  removedChatIds: {}, // Track removed chats to prevent re-hydration
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
  // Group chats have no peer user — skip userId field to avoid matching self
  if (chatLike?.chatType === 'group' || chatLike?.isGroup) return null;
  return normalizeId(
    chatLike?.peerUser?._id ||
    chatLike?.peerUser?.userId ||
    chatLike?.peerUser?.id ||
    chatLike?.participantId ||
    chatLike?.peerUserId ||
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

const findChatIdByGroupId = (chatMap = {}, groupId) => {
  if (!groupId) return null;
  const gid = String(groupId);
  // Direct key match first
  if (chatMap[gid]) return gid;
  // Search entries whose groupId or group._id matches
  const allIds = Object.keys(chatMap || {});
  for (const id of allIds) {
    const entry = chatMap[id];
    const entryGroupId = normalizeId(entry?.groupId || entry?.group?._id);
    if (entryGroupId && entryGroupId === gid) return id;
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

const buildLastMessageDisplay = ({ chat, currentUserId, isTyping, typingUserName }) => {
  if (isTyping) {
    const isGroup = chat?.chatType === 'group' || chat?.isGroup;
    const typingText = isGroup && typingUserName
      ? `${typingUserName} is typing...`
      : 'Typing...';
    return {
      text: typingText,
      icon: null,
      prefix: '',
      isEdited: false,
      fullText: typingText,
    };
  }

  const rawLastMessage = chat?.lastMessage;

  // Handle deleted messages — show WhatsApp-style placeholder
  const isMsgDeleted = rawLastMessage?.isDeleted || rawLastMessage?.deletedFor === 'everyone';
  if (isMsgDeleted) {
    const deletedText = rawLastMessage?.placeholderText || rawLastMessage?.deletedText || 'This message was deleted';
    return {
      text: deletedText,
      icon: null,
      prefix: '',
      isEdited: false,
      isDeleted: true,
      fullText: deletedText,
    };
  }

  const messageText = typeof rawLastMessage === 'string' ? rawLastMessage : (rawLastMessage?.text || '');
  const messageType = (chat?.lastMessageType || rawLastMessage?.type || rawLastMessage?.messageType || 'text').toString().toLowerCase();
  const messageSender = chat?.lastMessageSender || rawLastMessage?.senderId || null;
  const isEdited = Boolean(rawLastMessage?.isEdited || chat?.lastMessageEdited || rawLastMessage?.editedAt);
  const icon = MESSAGE_TYPE_ICON_MAP[messageType] || null;
  const isGroupChat = chat?.chatType === 'group' || chat?.isGroup;

  // For group chats, the lastMessage.text already contains the sender prefix (e.g. "John: Hello")
  // so we should not add another "You:" prefix. For private chats, add "You:" if the sender is current user.
  const baseText = isGroupChat
    ? (messageText || getMessageTypeDisplayText(messageType, '', rawLastMessage?.mediaMeta || rawLastMessage?.metadata || {}))
    : getMessageTypeDisplayText(messageType, messageText, rawLastMessage?.mediaMeta || rawLastMessage?.metadata || {});
  const prefix = (!isGroupChat && currentUserId && messageSender && String(currentUserId) === String(messageSender)) ? 'You: ' : '';
  const editedSuffix = isEdited ? ' (edited)' : '';

  return {
    text: baseText,
    icon,
    prefix,
    isEdited,
    isDeleted: false,
    fullText: `${prefix}${icon && !isGroupChat ? `${icon} ` : ''}${baseText}${editedSuffix}`.trim(),
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
  const chatId = normalizeId(source?.chatId || item?.chatId || item?._id || source?.groupId || item?.groupId || null);

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
  const incomingText =
    item?.lastMessage?.text ||
    (typeof item?.lastMessage === 'string' ? item.lastMessage : null) ||
    item?.text ||
    '';

  const incomingMsgId = normalizeId(
    item?.lastMessage?.serverMessageId || item?.lastMessage?.messageId || item?.messageId || item?.lastMessage?.id || item?.id
  );
  const existingMsgId = getMessageIdentifier(baseLastMessage);

  // If the existing lastMessage was edited locally and the incoming update refers to the same message,
  // preserve the edited text (server may not have caught up yet)
  const isSameMessage = incomingMsgId && existingMsgId && String(incomingMsgId) === String(existingMsgId);
  const keepLocalEdit = isSameMessage && baseLastMessage?.isEdited && !item?.lastMessage?.isEdited && !item?.isEdited;

  // If the existing lastMessage was deleted locally, preserve the deleted state unless
  // the incoming is a genuinely different (new) message or acknowledges the delete
  const existingIsDeleted = baseLastMessage?.isDeleted === true || baseLastMessage?.deletedFor === 'everyone';
  const incomingAcksDelete = item?.lastMessage?.isDeleted === true || item?.lastMessage?.deletedFor === 'everyone';
  const isNewDifferentMessage = incomingMsgId && existingMsgId && String(incomingMsgId) !== String(existingMsgId);
  const keepLocalDelete = existingIsDeleted && !incomingAcksDelete && !isNewDifferentMessage;

  const messageText = keepLocalDelete
    ? (baseLastMessage.placeholderText || baseLastMessage.text)
    : (keepLocalEdit ? baseLastMessage.text : (incomingText || baseLastMessage?.text || ''));

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
    isEdited: keepLocalEdit ? true : (item?.lastMessage?.isEdited || item?.isEdited || baseLastMessage?.isEdited || false),
    editedAt: keepLocalEdit ? baseLastMessage.editedAt : (item?.lastMessage?.editedAt || item?.editedAt || baseLastMessage?.editedAt || null),
    isDeleted: keepLocalDelete ? true : (item?.lastMessage?.isDeleted || baseLastMessage?.isDeleted || false),
    deletedFor: keepLocalDelete ? 'everyone' : (item?.lastMessage?.deletedFor || baseLastMessage?.deletedFor || null),
    placeholderText: keepLocalDelete ? baseLastMessage.placeholderText : (item?.lastMessage?.placeholderText || baseLastMessage?.placeholderText || null),
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
    const isGroup = chat?.chatType === 'group' || chat?.isGroup;
    return {
      chatId,
      _id: chat?._id || chatId,
      chatType: chat?.chatType || (isGroup ? 'group' : 'private'),
      isGroup: Boolean(isGroup),
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
      // Group-specific fields
      ...(isGroup ? {
        groupId: chat?.groupId || chat?.group?._id || null,
        chatName: chat?.chatName || chat?.group?.name || chat?.groupName || null,
        chatAvatar: chat?.chatAvatar || chat?.group?.avatar || chat?.groupAvatar || null,
        groupName: chat?.chatName || chat?.group?.name || chat?.groupName || null,
        groupAvatar: chat?.chatAvatar || chat?.group?.avatar || chat?.groupAvatar || null,
        group: chat?.group || null,
        members: Array.isArray(chat?.members) ? chat.members : [],
        memberCount: chat?.memberCount || chat?.members?.length || 0,
      } : {}),
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
    chatId: normalizeId(source?.chatId || source?.roomId || source?.chat || source?.groupId || null),
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

      incoming.forEach((rawChat) => {
        // Normalize flat API response into the shape the app expects
        const isGroupChat = rawChat?.chatType === 'group' || rawChat?.isGroup;
        const chat = { ...rawChat };

        // Build peerUser object from flat fields if not already present (new API format)
        if (!isGroupChat && !chat.peerUser && chat.peerUserId) {
          chat.peerUser = {
            _id: chat.peerUserId,
            fullName: chat.chatName || '',
            profileImage: chat.chatAvatar || null,
          };
        }

        // Build group object from flat fields if not already present (new API format)
        if (isGroupChat && !chat.group && (chat.groupId || chat.chatId)) {
          chat.isGroup = true;
          chat.groupId = chat.groupId || chat.chatId;
          chat.group = {
            _id: chat.groupId || chat.chatId,
            name: chat.chatName || '',
            avatar: chat.chatAvatar || null,
          };
          chat.groupName = chat.chatName || '';
          chat.groupAvatar = chat.chatAvatar || null;
          chat.memberCount = chat.groupMembersCount || chat.memberCount || 0;
        }

        // Map archived field
        if (chat.archived !== undefined && chat.isArchived === undefined) {
          chat.isArchived = Boolean(chat.archived);
        }

        const normalizedChatId = normalizeId(chat?.chatId || chat?._id);
        const normalizedGroupId = normalizeId(chat?.groupId || chat?.group?._id);
        const peerUserId = getPeerUserId(chat);
        const aliasChatId = findChatIdByPeer(nextMap, peerUserId, normalizedChatId);
        const chatId = normalizedChatId || aliasChatId;
        if (!chatId) return;

        // Skip chats that were removed in this session (prevents re-adding deleted groups)
        if (state.removedChatIds[chatId] || (normalizedGroupId && state.removedChatIds[normalizedGroupId])) return;

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
        const normalizedPeerUser = isGroupChat
          ? null
          : {
              ...(prev?.peerUser || {}),
              ...(chat?.peerUser || {}),
              _id: normalizeId(chat?.peerUser?._id || chat?.peerUser?.userId || chat?.peerUser?.id || prev?.peerUser?._id || prev?.peerUser?.userId || prev?.peerUser?.id || peerUserId),
            };

        // Preserve locally edited lastMessage if server hasn't caught up
        const prevLastMsg = prev?.lastMessage;
        const incomingLastMsg = chat?.lastMessage;
        const prevMsgId = getMessageIdentifier(prevLastMsg || {});
        const incomingMsgId = normalizeId(
          incomingLastMsg?.serverMessageId || incomingLastMsg?.messageId || incomingLastMsg?.id ||
          chat?.lastMessage?.serverMessageId || chat?.lastMessage?.messageId
        );
        const sameMsg = prevMsgId && incomingMsgId && String(prevMsgId) === String(incomingMsgId);
        // Preserve local edit if server hasn't acknowledged the edit yet
        const preserveEdit = (prevLastMsg?.isEdited || prev?.lastMessageEdited) && !incomingLastMsg?.isEdited && !chat?.lastMessageEdited;

        // Preserve local lastMessage if it's newer than what the API returned
        // This prevents pull-to-refresh from reverting socket-updated messages
        const prevLastMsgTs = toTimestamp(prev?.lastMessageAt || prevLastMsg?.createdAt);
        const incomingLastMsgTs = toTimestamp(chat?.lastMessageAt || incomingLastMsg?.createdAt);
        const localIsNewer = prevLastMsgTs > 0 && incomingLastMsgTs > 0 && prevLastMsgTs > incomingLastMsgTs;
        const preserveLocal = preserveEdit || localIsNewer;

        // Preserve local isArchived/isPinned/isMuted if set optimistically but API hasn't caught up
        const preserveArchived = Boolean(prev?.isArchived) && !Boolean(chat?.isArchived);
        const preservePinned = Boolean(prev?.isPinned) && !Boolean(chat?.isPinned);
        const preserveMuted = Boolean(prev?.isMuted) && !Boolean(chat?.isMuted);

        nextMap[chatId] = {
          ...prev,
          ...chat,
          _id: normalizeId(chat?._id) || chatId,
          chatId,
          peerUser: normalizedPeerUser,
          unreadCount,
          lastMessage: preserveLocal ? prevLastMsg : (incomingLastMsg || prevLastMsg),
          lastMessageEdited: preserveEdit ? true : (chat?.lastMessageEdited || prev?.lastMessageEdited || false),
          lastMessageAt: preserveLocal
            ? (prev?.lastMessageAt || prevLastMsg?.createdAt || chat?.lastMessageAt)
            : (chat?.lastMessageAt || prev?.lastMessageAt || chat?.lastMessage?.createdAt || prev?.lastMessage?.createdAt),
          ...(preserveArchived ? { isArchived: true } : {}),
          ...(preservePinned ? { isPinned: true, pinnedAt: prev?.pinnedAt } : {}),
          ...(preserveMuted ? { isMuted: true, mutedUntil: prev?.mutedUntil } : {}),
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

        const cachePreserveEdit = (existing?.lastMessage?.isEdited || existing?.lastMessageEdited) && !chat?.lastMessage?.isEdited && !chat?.lastMessageEdited;

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
          ...(cachePreserveEdit ? { lastMessage: existing.lastMessage, lastMessageEdited: true } : {}),
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
      // Block cancelled/failed messages from updating chat list
      if (message.status === 'cancelled' || message.status === 'failed') return state;
      // Block scheduled/processing ONLY if scheduleTime is still in the future
      if (message.status === 'scheduled' || message.status === 'processing') {
        const st = message.scheduleTime || message.schedule_time;
        const stMs = st ? new Date(st).getTime() : 0;
        const isDeliveryNow = message.isScheduled === false || !st || !Number.isFinite(stMs) || stMs <= Date.now() + 5000;
        if (!isDeliveryNow) return state;
      }
      // Block isScheduled on receiver side only if scheduleTime is still in the future
      const isSelf = message.senderId && state.currentUserId && String(message.senderId) === String(state.currentUserId);
      if (!isSelf && message.isScheduled) {
        const st = message.scheduleTime || message.schedule_time;
        const stMs = st ? new Date(st).getTime() : 0;
        if (Number.isFinite(stMs) && stMs > Date.now() + 5000) return state;
      }
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

      // Protect deleted lastMessage from being overwritten by stale server echo
      const existingLastMsg = existing.lastMessage || {};
      const existingIsDeleted = existingLastMsg?.isDeleted === true || existingLastMsg?.deletedFor === 'everyone';
      const incomingMsgId = normalizeId(message.messageId || message.id || message.serverMessageId);
      const existingMsgId = normalizeId(existingLastMsg?.serverMessageId || existingLastMsg?.messageId || existingLastMsg?.id);
      const isNewDifferentMsg = incomingMsgId && existingMsgId && String(incomingMsgId) !== String(existingMsgId);
      const preserveDelete = existingIsDeleted && !isNewDifferentMsg;

      const lastMessage = preserveDelete
        ? {
            ...existingLastMsg,
            status: pickHighestMessageStatus(existingLastMsg?.status, message.status),
          }
        : {
            ...existingLastMsg,
            id: message.id || message.messageId || existingLastMsg?.id || null,
            messageId: message.messageId || message.id || existingLastMsg?.messageId || null,
            serverMessageId: message.serverMessageId || message.messageId || message.id || existingLastMsg?.serverMessageId || null,
            tempId: message.tempId || existingLastMsg?.tempId || null,
            text: message.text || message.content || existingLastMsg?.text || '',
            createdAt: lastMessageAt,
            senderId: message.senderId,
            status: pickHighestMessageStatus(existingLastMsg?.status, message.status),
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
      const rawChatId = normalizeId(message.chatId);
      const rawGroupId = normalizeId(message.groupId);
      const isGroupMsg = Boolean(rawGroupId || message.chatType === 'group');

      // Resolve chatId: for groups, the chatMap key may differ from chatId
      const chatId = rawChatId && state.chatMap[rawChatId]
        ? rawChatId
        : (rawGroupId && state.chatMap[rawGroupId])
          ? rawGroupId
          : (isGroupMsg ? findChatIdByGroupId(state.chatMap, rawGroupId || rawChatId) : null)
            || rawChatId;

      if (!chatId) return state;

      const existing = state.chatMap[chatId] || { _id: chatId, chatId };
      const lastMessageAt = message.createdAt || new Date().toISOString();

      // For group chats, format text as "You: <text>" to match the preview format
      const outgoingText = isGroupMsg
        ? `You: ${message.text || ''}`
        : (message.text || existing?.lastMessage?.text || '');

      const lastMessage = {
        ...(existing.lastMessage || {}),
        id: message.id || message.messageId || existing?.lastMessage?.id || null,
        messageId: message.messageId || message.id || existing?.lastMessage?.messageId || null,
        serverMessageId: message.serverMessageId || message.messageId || message.id || existing?.lastMessage?.serverMessageId || null,
        tempId: message.tempId || existing?.lastMessage?.tempId || null,
        text: outgoingText,
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
          lastMessageSender: message.senderId || existing?.lastMessageSender || null,
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
      const rawChatId = normalizeId(payload.chatId);
      if (!rawChatId) return state;

      // Find the chat entry — key might differ from the chatId we have
      let chatId = rawChatId;
      if (!state.chatMap[chatId]) {
        // Extract user IDs from u_xxx_yyy format for reverse match
        const parts = String(rawChatId).startsWith('u_') ? String(rawChatId).split('_').slice(1) : [];
        const reversedChatId = parts.length === 2 ? `u_${parts[1]}_${parts[0]}` : null;

        const found = Object.keys(state.chatMap).find(key => {
          const entry = state.chatMap[key];
          return String(entry?.chatId) === String(rawChatId) ||
                 String(entry?._id) === String(rawChatId) ||
                 String(key) === String(rawChatId) ||
                 (reversedChatId && (String(key) === reversedChatId || String(entry?.chatId) === reversedChatId));
        });
        if (found) chatId = found;
      }

      const existing = state.chatMap[chatId] || { _id: chatId, chatId };
      const lastMsg = payload.lastMessage || existing.lastMessage || { text: 'No messages yet', type: 'text' };
      const nextMap = {
        ...state.chatMap,
        [chatId]: {
          ...existing,
          chatId,
          _id: normalizeId(existing._id) || chatId,
          lastMessage: lastMsg,
          lastMessageType: payload.lastMessageType || lastMsg?.type || existing.lastMessageType || 'text',
          lastMessageSender: payload.lastMessageSender ?? lastMsg?.senderId ?? existing.lastMessageSender ?? null,
          lastMessageAt: payload.lastMessageAt || lastMsg?.createdAt || existing.lastMessageAt || null,
          lastMessageEdited: payload.lastMessageEdited || lastMsg?.isEdited ? true : (existing.lastMessageEdited || false),
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

    case 'REMOVE_CANCELLED_SCHEDULED': {
      // When a scheduled message is cancelled, remove it from chat list if it was the last message
      const cancelledMsgId = normalizeId(action.payload?.messageId);
      if (!cancelledMsgId) return state;
      const chatMap = { ...state.chatMap };
      let changed = false;
      for (const cid of Object.keys(chatMap)) {
        const chat = chatMap[cid];
        const lm = chat?.lastMessage;
        const lmId = normalizeId(lm?.messageId || lm?.serverMessageId || lm?.id || lm?.tempId);
        if (lmId === cancelledMsgId) {
          // Clear last message so cancelled message doesn't show in chat list
          chatMap[cid] = { ...chat, lastMessage: { ...lm, text: '', status: null }, lastMessageStatus: null };
          changed = true;
        }
      }
      if (!changed) return state;
      const sections = buildOrderedSections(chatMap);
      return { ...state, chatMap, sortedChatIds: sections.sortedChatIds, pinnedChatIds: sections.pinnedChatIds, regularChatIds: sections.regularChatIds, archivedChatIds: sections.archivedChatIds };
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

    case 'UPDATE_LAST_MESSAGE_DELETED': {
      const { chatId: rawDelChatId, messageId: rawDelMsgId, placeholderText } = action.payload || {};
      const delChatId = normalizeId(rawDelChatId);
      const delMsgId = normalizeId(rawDelMsgId);
      if (!delChatId || !state.chatMap[delChatId]) return state;

      const chatMap = { ...state.chatMap };
      const existing = chatMap[delChatId];
      const lastMsg = existing?.lastMessage;
      const lastMsgId = getMessageIdentifier(lastMsg);

      // Only update if the deleted message is the last message in the chat list
      if (lastMsg && delMsgId && lastMsgId === delMsgId) {
        chatMap[delChatId] = {
          ...existing,
          lastMessage: {
            ...lastMsg,
            text: placeholderText || 'This message was deleted',
            isDeleted: true,
          },
        };
        return { ...state, chatMap };
      }
      return state;
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

        const { chatId: rawUpdateChatId, type, item, timestamp } = update;
        const itemPeerUserId = getPeerUserId(item);
        const aliasChatId = findChatIdByPeer(nextMap, itemPeerUserId, rawUpdateChatId);
        // For group chats, resolve the chatId if it doesn't directly match a key in chatMap
        const itemGroupId = normalizeId(item?.groupId || item?.group?._id);
        const chatId = nextMap[rawUpdateChatId]
          ? rawUpdateChatId
          : (aliasChatId || (itemGroupId ? findChatIdByGroupId(nextMap, itemGroupId) : null) || rawUpdateChatId);
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

        // Check if existing lastMessage was edited locally and server hasn't caught up
        const existingLastMsg = existing?.lastMessage;
        const incomingLastMsg = item?.lastMessage;
        const existingWasEdited = existingLastMsg?.isEdited === true || existing?.lastMessageEdited === true;
        const incomingAcksEdit = incomingLastMsg?.isEdited === true || item?.isEdited === true;
        const shouldPreserveEdit = existingWasEdited && !incomingAcksEdit && type !== 'message_edited';

        // Check if existing lastMessage was deleted locally and server hasn't caught up
        const existingWasDeleted = existingLastMsg?.isDeleted === true || existingLastMsg?.deletedFor === 'everyone';
        const incomingAcksDelete = incomingLastMsg?.isDeleted === true || incomingLastMsg?.deletedFor === 'everyone';
        const shouldPreserveDelete = existingWasDeleted && !incomingAcksDelete && type !== 'message_deleted';

        const mergedBase = {
          ...existing,
          ...item,
          _id: normalizeId(item?._id) || normalizeId(existing?._id) || chatId,
          chatId,
          peerUser: mergedPeerUser,
          // Preserve edited lastMessage over server's old data
          ...(shouldPreserveEdit ? {
            lastMessage: existingLastMsg,
            lastMessageEdited: true,
          } : {}),
          // Preserve deleted lastMessage over server's stale data
          ...(shouldPreserveDelete ? {
            lastMessage: existingLastMsg,
          } : {}),
        };

        if (typeof item?.unreadCount === 'number') {
          unreadByChat[chatId] = Number(item.unreadCount);
        }

        switch (type) {
          case 'new_message': {
            // Block pending scheduled/processing/cancelled/failed messages from updating chat list
            const lm = item?.lastMessage;
            const itemStatus = lm?.status || item?.status;
            if (itemStatus === 'scheduled' || itemStatus === 'processing' || itemStatus === 'cancelled' || itemStatus === 'failed') {
              break; // Skip — not a real delivered message
            }
            // Also block if scheduleTime is in the future (safety net)
            const schedTime = lm?.scheduleTime || item?.scheduleTime;
            if (schedTime && new Date(schedTime).getTime() > Date.now() + 5000) {
              break;
            }
            const lastMessage = buildLastMessageFromItem(existing, item, timestamp);
            const isActiveChat = state.activeChatId && String(state.activeChatId) === String(chatId);
            // Use the higher of local count and server count as base, then increment by 1
            const localUnread = Number(unreadByChat[chatId] || existing?.unreadCount || 0);
            const serverUnread = typeof item?.unreadCount === 'number' ? Number(item.unreadCount) : 0;
            const baseUnread = Math.max(localUnread, serverUnread);
            unreadByChat[chatId] = isActiveChat ? 0 : baseUnread + 1;

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
            const editedText = item?.lastMessage?.text
              || (typeof item?.lastMessage === 'string' ? item.lastMessage : null)
              || item?.text
              || existing?.lastMessage?.text
              || '';
            const lastMessage = {
              ...(existing?.lastMessage || {}),
              text: editedText,
              type: item?.lastMessageType || existing?.lastMessage?.type || 'text',
              senderId: item?.lastMessageSender || item?.lastMessage?.senderId || existing?.lastMessage?.senderId || existing?.lastMessageSender || null,
              createdAt: item?.lastMessageAt || existing?.lastMessage?.createdAt || existing?.lastMessageAt || timestamp,
              isEdited: true,
              editedAt: item?.editedAt || item?.lastMessage?.editedAt || timestamp,
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
      // Skip own typing
      if (state.currentUserId && String(userId) === String(state.currentUserId)) return state;

      // Look up sender name from group members for group typing display
      const chatEntry = state.chatMap[chatId];
      let typingUserName = null;
      if (chatEntry?.chatType === 'group' || chatEntry?.isGroup) {
        const members = Array.isArray(chatEntry?.members) ? chatEntry.members : (Array.isArray(chatEntry?.participants) ? chatEntry.participants : []);
        const member = members.find((m) => {
          const mId = normalizeId(m?.userId || m?._id || m?.id);
          return mId && String(mId) === String(userId);
        });
        typingUserName = member?.fullName || member?.username || member?.name || null;
      }

      return {
        ...state,
        typingStates: {
          ...state.typingStates,
          [chatId]: {
            isTyping: true,
            userId,
            userName: typingUserName,
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

    // ─── GROUP: Incoming group message — update chat list preview ───
    case 'INCOMING_GROUP_MESSAGE': {
      const { chatId: rawChatId, groupId: rawGroupId, senderId, senderName, text, messageType, createdAt, messageId } = action.payload || {};
      const normalizedChatId = normalizeId(rawChatId);
      const normalizedGroupId = normalizeId(rawGroupId);

      // Resolve the actual key in chatMap: try chatId, then groupId, then search by groupId
      const resolvedId = (normalizedChatId && state.chatMap[normalizedChatId])
        ? normalizedChatId
        : (normalizedGroupId && state.chatMap[normalizedGroupId])
          ? normalizedGroupId
          : findChatIdByGroupId(state.chatMap, normalizedGroupId || normalizedChatId)
            || normalizedChatId
            || normalizedGroupId;

      if (!resolvedId) return state;

      const nextMap = { ...state.chatMap };
      const existing = nextMap[resolvedId] || {};
      const lastMessageAt = createdAt || new Date().toISOString();

      // Protect deleted lastMessage from being overwritten by stale echo
      const existingGrpLastMsg = existing.lastMessage || {};
      const existingGrpDeleted = existingGrpLastMsg?.isDeleted === true || existingGrpLastMsg?.deletedFor === 'everyone';
      const incomingGrpMsgId = normalizeId(messageId);
      const existingGrpMsgId = normalizeId(existingGrpLastMsg?.serverMessageId || existingGrpLastMsg?.messageId || existingGrpLastMsg?.id);
      const isNewDiffGrpMsg = incomingGrpMsgId && existingGrpMsgId && String(incomingGrpMsgId) !== String(existingGrpMsgId);
      const preserveGrpDelete = existingGrpDeleted && !isNewDiffGrpMsg;

      nextMap[resolvedId] = {
        ...existing,
        chatId: resolvedId,
        _id: existing._id || resolvedId,
        chatType: existing.chatType || 'group',
        isGroup: existing.isGroup !== undefined ? existing.isGroup : true,
        lastMessage: preserveGrpDelete
          ? existingGrpLastMsg
          : {
          ...(existing.lastMessage || {}),
          text: text || '',
          type: messageType || 'text',
          senderId,
          senderName,
          messageId,
          serverMessageId: messageId,
          createdAt: lastMessageAt,
        },
        lastMessageAt: preserveGrpDelete ? (existing.lastMessageAt || lastMessageAt) : lastMessageAt,
        timestamp: preserveGrpDelete ? (existing.timestamp || existing.lastMessageAt || lastMessageAt) : lastMessageAt,
        lastMessageType: preserveGrpDelete ? existing.lastMessageType : (messageType || 'text'),
        lastMessageSender: preserveGrpDelete ? existing.lastMessageSender : (senderId || null),
      };

      // Increment unread if not the active chat — skip if preserving a delete
      const unreadByChat = { ...state.unreadByChat };
      const isOwnMessage = senderId && state.currentUserId && String(senderId) === String(state.currentUserId);
      if (!preserveGrpDelete && senderId && state.currentUserId && !isOwnMessage && state.activeChatId !== resolvedId) {
        unreadByChat[resolvedId] = Number(unreadByChat[resolvedId] || existing?.unreadCount || 0) + 1;
        nextMap[resolvedId].unreadCount = unreadByChat[resolvedId];
      }

      const sections = buildOrderedSections(nextMap);
      return {
        ...state,
        chatMap: nextMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        unreadByChat,
        totalUnread: recomputeTotalUnread(unreadByChat),
      };
    }

    // ─── GROUP: Remove chat from list (after leave/delete) ───
    case 'REMOVE_CHAT': {
      const targetId = normalizeId(action.payload);
      if (!targetId) return state;

      const nextMap = { ...state.chatMap };
      const unreadByChat = { ...state.unreadByChat };
      const removedChatIds = { ...state.removedChatIds };

      // Remove by direct ID
      if (nextMap[targetId]) {
        delete nextMap[targetId];
        delete unreadByChat[targetId];
      }

      // Also remove any entry whose chatId or groupId matches the target
      Object.keys(nextMap).forEach((key) => {
        const entry = nextMap[key];
        const entryChatId = normalizeId(entry?.chatId);
        const entryGroupId = normalizeId(entry?.groupId || entry?.group?._id);
        if (entryChatId === targetId || entryGroupId === targetId) {
          delete nextMap[key];
          delete unreadByChat[key];
        }
      });

      // Track as removed so HYDRATE_CHATS won't re-add it
      removedChatIds[targetId] = Date.now();

      const sections = buildOrderedSections(nextMap);

      return {
        ...state,
        chatMap: nextMap,
        sortedChatIds: sections.sortedChatIds,
        pinnedChatIds: sections.pinnedChatIds,
        regularChatIds: sections.regularChatIds,
        archivedChatIds: sections.archivedChatIds,
        unreadByChat,
        totalUnread: recomputeTotalUnread(unreadByChat),
        removedChatIds,
      };
    }

    // ─── GROUP: Update member list on a group chat ───
    case 'GROUP_MEMBER_JOINED': {
      const { groupId, userId, username, timestamp } = action.payload || {};
      const chatId = normalizeId(groupId);
      if (!chatId || !state.chatMap[chatId]) return state;

      const chat = state.chatMap[chatId];
      const existingMembers = Array.isArray(chat.members) ? chat.members : [];
      const alreadyExists = existingMembers.some((m) => {
        const mId = typeof m.userId === 'object' ? m.userId?._id : m.userId;
        return normalizeId(mId) === normalizeId(userId);
      });
      if (alreadyExists) return state;

      return {
        ...state,
        chatMap: {
          ...state.chatMap,
          [chatId]: {
            ...chat,
            members: [...existingMembers, { userId, fullName: username, role: 'member', joinedAt: timestamp }],
            memberCount: (chat.memberCount || existingMembers.length) + 1,
          },
        },
      };
    }

    case 'GROUP_MEMBER_LEFT': {
      const { groupId, userId } = action.payload || {};
      const chatId = normalizeId(groupId);
      if (!chatId || !state.chatMap[chatId]) return state;

      const chat = state.chatMap[chatId];
      const existingMembers = Array.isArray(chat.members) ? chat.members : [];
      const filteredMembers = existingMembers.filter((m) => {
        const mId = typeof m.userId === 'object' ? m.userId?._id : m.userId;
        return normalizeId(mId) !== normalizeId(userId);
      });

      return {
        ...state,
        chatMap: {
          ...state.chatMap,
          [chatId]: {
            ...chat,
            members: filteredMembers,
            memberCount: filteredMembers.length,
          },
        },
      };
    }

    // ─── GROUP: Member removed (kicked) ───
    case 'GROUP_MEMBER_REMOVED': {
      const { groupId, userId } = action.payload || {};
      const chatId = normalizeId(groupId);
      if (!chatId || !state.chatMap[chatId]) return state;

      const chat = state.chatMap[chatId];
      const members = Array.isArray(chat.members) ? chat.members : [];
      const filtered = members.filter((m) => {
        const mId = typeof m.userId === 'object' ? m.userId?._id : m.userId;
        return normalizeId(mId) !== normalizeId(userId);
      });

      return {
        ...state,
        chatMap: {
          ...state.chatMap,
          [chatId]: { ...chat, members: filtered, memberCount: filtered.length },
        },
      };
    }

    // ─── GROUP: Member role changed (promote/demote) ───
    case 'GROUP_MEMBER_ROLE_CHANGED': {
      const { groupId, userId, newRole } = action.payload || {};
      const chatId = normalizeId(groupId);
      if (!chatId || !state.chatMap[chatId]) return state;

      const chat = state.chatMap[chatId];
      const members = Array.isArray(chat.members) ? chat.members : [];
      const updatedMembers = members.map((m) => {
        const mId = typeof m.userId === 'object' ? m.userId?._id : m.userId;
        if (normalizeId(mId) === normalizeId(userId)) {
          return { ...m, role: newRole };
        }
        return m;
      });

      return {
        ...state,
        chatMap: {
          ...state.chatMap,
          [chatId]: { ...chat, members: updatedMembers },
        },
      };
    }

    // ─── GROUP: Member muted ───
    case 'GROUP_MEMBER_MUTED': {
      const { groupId, userId, mutedTill } = action.payload || {};
      const chatId = normalizeId(groupId);
      if (!chatId || !state.chatMap[chatId]) return state;

      const chat = state.chatMap[chatId];
      const members = Array.isArray(chat.members) ? chat.members : [];
      const updatedMembers = members.map((m) => {
        const mId = typeof m.userId === 'object' ? m.userId?._id : m.userId;
        if (normalizeId(mId) === normalizeId(userId)) {
          return { ...m, isMuted: true, mutedTill };
        }
        return m;
      });

      return {
        ...state,
        chatMap: {
          ...state.chatMap,
          [chatId]: { ...chat, members: updatedMembers },
        },
      };
    }

    // ─── GROUP: Member unmuted ───
    case 'GROUP_MEMBER_UNMUTED': {
      const { groupId, userId } = action.payload || {};
      const chatId = normalizeId(groupId);
      if (!chatId || !state.chatMap[chatId]) return state;

      const chat = state.chatMap[chatId];
      const members = Array.isArray(chat.members) ? chat.members : [];
      const updatedMembers = members.map((m) => {
        const mId = typeof m.userId === 'object' ? m.userId?._id : m.userId;
        if (normalizeId(mId) === normalizeId(userId)) {
          return { ...m, isMuted: false, mutedTill: null };
        }
        return m;
      });

      return {
        ...state,
        chatMap: {
          ...state.chatMap,
          [chatId]: { ...chat, members: updatedMembers },
        },
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
  const handledGroupMsgIdsRef = useRef(new Set());
  const currentUserIdRef = useRef(state.currentUserId);
  currentUserIdRef.current = state.currentUserId;
  const stateRef = useRef(state);
  stateRef.current = state;

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
      const source = unwrapPayload(payload);
      // Handle group messages — forward to INCOMING_GROUP_MESSAGE for proper unread count tracking.
      // Only treat as group if chatType is explicitly 'group' AND the message has a groupId target.
      // Don't treat forwarded/replied 1-on-1 messages that merely reference a groupId from their origin.
      const sourceIsGroup = (source?.chatType === 'group' || source?.data?.chatType === 'group') &&
        (source?.groupId || source?.data?.groupId);
      if (sourceIsGroup) {
        // Dedup: skip if already processed by onGroupMessageNew
        const grpMsgId = normalizeId(source?.messageId || source?._id || source?.data?.messageId || source?.data?._id);
        if (grpMsgId && handledGroupMsgIdsRef.current.has(grpMsgId)) return;
        if (grpMsgId) {
          handledGroupMsgIdsRef.current.add(grpMsgId);
          if (handledGroupMsgIdsRef.current.size > 2000) {
            const first = handledGroupMsgIdsRef.current.values().next().value;
            handledGroupMsgIdsRef.current.delete(first);
          }
        }

        const grpGroupId = normalizeId(source?.groupId || source?.data?.groupId);
        const grpChatId = normalizeId(source?.chatId || source?.data?.chatId) || grpGroupId;
        const grpSenderId = normalizeId(source?.senderId || source?.data?.senderId);

        // Resolve senderName — look up from group members if not in payload
        let grpSenderName = source?.senderName || source?.data?.senderName || source?.sender?.fullName || source?.data?.sender?.fullName || '';
        if (!grpSenderName && grpSenderId) {
          const currentState = stateRef.current;
          const resolvedKey = (grpChatId && currentState.chatMap[grpChatId])
            ? grpChatId
            : (grpGroupId && currentState.chatMap[grpGroupId])
              ? grpGroupId
              : findChatIdByGroupId(currentState.chatMap, grpGroupId || grpChatId);
          const groupEntry = resolvedKey ? currentState.chatMap[resolvedKey] : null;
          if (groupEntry) {
            const members = Array.isArray(groupEntry.members) ? groupEntry.members : (Array.isArray(groupEntry.participants) ? groupEntry.participants : []);
            const member = members.find((m) => {
              const mId = normalizeId(m?.userId || m?._id || m?.id);
              return mId && mId === String(grpSenderId);
            });
            grpSenderName = member?.fullName || member?.username || member?.name || '';
          }
        }

        const grpText = source?.text || source?.data?.text || '';
        const grpMessageType = source?.messageType || source?.data?.messageType || source?.type || 'text';
        // Handle both ISO string (createdAt) and epoch ms (sentAt) timestamps
        const grpRawTs = source?.createdAt || source?.data?.createdAt || source?.sentAt || source?.data?.sentAt || source?.timestamp || source?.data?.timestamp;
        const grpCreatedAt = grpRawTs
          ? (typeof grpRawTs === 'number' ? new Date(grpRawTs).toISOString() : grpRawTs)
          : new Date().toISOString();

        // Build preview text for chat list
        const isSystem = grpMessageType === 'system';
        let previewText = grpText;
        if (grpMessageType === 'image') previewText = 'Photo';
        else if (grpMessageType === 'video') previewText = 'Video';
        else if (grpMessageType === 'audio') previewText = 'Audio';
        else if (grpMessageType === 'file') previewText = 'Document';
        else if (grpMessageType === 'location') previewText = 'Location';
        else if (grpMessageType === 'contact') previewText = 'Contact';

        const fullPreview = isSystem ? previewText : (grpSenderName ? `${grpSenderName}: ${previewText}` : previewText);

        dispatch({
          type: 'INCOMING_GROUP_MESSAGE',
          payload: {
            chatId: grpChatId,
            groupId: grpGroupId,
            senderId: grpSenderId,
            senderName: grpSenderName,
            text: fullPreview,
            messageType: grpMessageType,
            createdAt: grpCreatedAt,
            messageId: grpMsgId,
          },
        });
        return;
      }

      // Check if this is a scheduled message being delivered now (scheduleTime passed)
      const schedTime = source?.scheduleTime || source?.schedule_time || source?.data?.scheduleTime;
      const schedTimeMs = schedTime ? new Date(schedTime).getTime() : 0;
      const isScheduledDelivery = (source?.isScheduled || source?.data?.isScheduled) &&
        (!schedTime || !Number.isFinite(schedTimeMs) || schedTimeMs <= Date.now() + 5000);

      // Block pending scheduled/processing messages — UNLESS it's a scheduled delivery
      const msgStatus = source?.status || source?.data?.status;
      if ((msgStatus === 'scheduled' || msgStatus === 'processing') && !isScheduledDelivery) return;
      if (msgStatus === 'cancelled' || msgStatus === 'failed') return;

      // Block premature scheduled messages (scheduleTime in future)
      if (schedTime && Number.isFinite(schedTimeMs) && schedTimeMs > Date.now() + 5000) return;

      // Strip schedule flags for delivered scheduled messages so chat list shows them as normal
      const isSelf = source?.senderId && currentUserIdRef.current && String(source.senderId) === String(currentUserIdRef.current);
      if (!isSelf && (source?.isScheduled || source?.data?.isScheduled)) {
        if (source) { source.isScheduled = false; source.scheduleTime = null; source.scheduleTimeLabel = null; source.status = source.status === 'scheduled' ? 'sent' : source.status; }
        if (source?.data) { source.data.isScheduled = false; source.data.scheduleTime = null; source.data.scheduleTimeLabel = null; }
      }
      const normalized = normalizeMessagePayload(payload);
      dispatch({ type: 'INCOMING_MESSAGE', payload: normalized });

      // Persist to SQLite so messages are available when ChatScreen opens later
      const msgId = normalized.serverMessageId || normalized.messageId || normalized.id;
      if (msgId && !isSelf) {
        const ts = normalized.createdAt ? new Date(normalized.createdAt).getTime() : Date.now();

        // Extract reply data — server may send replyTo as object or string
        const srcReplyTo = source?.replyTo;
        const srcReplyIsObj = srcReplyTo && typeof srcReplyTo === 'object';
        const replyToMsgId = source?.replyToMessageId || source?.quotedMessageId
          || (srcReplyIsObj ? (srcReplyTo._id || srcReplyTo.id) : srcReplyTo)
          || source?.reply_to_message_id || null;
        const replyPreviewText = source?.replyPreviewText || source?.quotedText
          || (srcReplyIsObj ? srcReplyTo.text : null) || null;
        const replyPreviewType = source?.replyPreviewType
          || (srcReplyIsObj ? (srcReplyTo.messageType || srcReplyTo.type) : null) || null;
        const replySenderId = source?.replySenderId
          || (srcReplyIsObj ? (srcReplyTo.senderId || srcReplyTo.sender?._id) : null) || null;
        const replySenderName = source?.replySenderName || source?.quotedSender
          || (srcReplyIsObj ? (srcReplyTo.senderName || srcReplyTo.sender?.fullName) : null) || null;

        ChatDatabase.upsertMessage({
          id: msgId,
          serverMessageId: msgId,
          tempId: normalized.tempId || null,
          chatId: normalized.chatId,
          senderId: normalized.senderId,
          text: normalized.text || '',
          type: source?.messageType || source?.type || 'text',
          status: normalized.status || 'sent',
          timestamp: Number.isFinite(ts) ? ts : Date.now(),
          createdAt: normalized.createdAt,
          synced: 1,
          mediaUrl: source?.mediaUrl || null,
          mediaType: source?.mediaType || null,
          replyToMessageId: replyToMsgId,
          replyPreviewText,
          replyPreviewType,
          replySenderName,
          replySenderId,
        }).catch(() => {});

        // Save reply data to permanent reply table
        if (replyToMsgId) {
          ChatDatabase.saveReplyData(msgId, {
            replyToMessageId: replyToMsgId,
            replyPreviewText,
            replyPreviewType,
            replySenderName,
            replySenderId,
          }).catch(() => {});
        }

        // Update chatlist in SQLite — last message + unread count
        ChatDatabase.updateChatLastMessage(normalized.chatId, {
          text: normalized.text || '',
          type: source?.messageType || source?.type || 'text',
          senderId: normalized.senderId,
          status: normalized.status || 'sent',
          createdAt: normalized.createdAt,
          serverMessageId: msgId,
        }).catch(() => {});
        ChatDatabase.incrementChatUnread(normalized.chatId).catch(() => {});
      }
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
      const readerId = source?.senderId || source?.readBy || source?.userId;
      // MARK_READ clears unread badge — always do this when we read incoming messages
      if (chatId && readerId && String(readerId) === String(currentUserIdRef.current)) {
        dispatch({ type: 'MARK_READ', payload: chatId });
        return; // Don't update lastMessageStatus — this is OUR read, not the peer's
      }
      // Only update last message status to 'read' if a peer triggered it
      if (readerId && String(readerId) !== String(currentUserIdRef.current)) {
        dispatchLastMessageStatusUpdate(payload, 'read');
      }
    };
    const onMessageDelivered = (payload) => dispatchLastMessageStatusUpdate(payload, 'delivered');
    const onMessageReadBulk = (payload) => {
      const source = unwrapPayload(payload);
      const readerId = source?.senderId || source?.readBy || source?.userId;
      if (!readerId || String(readerId) === String(currentUserIdRef.current)) return;
      dispatchLastMessageStatusUpdate(payload, 'read');
    };
    const onMessageReadBulkResponse = (payload) => {
      const source = unwrapPayload(payload);
      const readerId = source?.senderId || source?.readBy || source?.userId;
      if (!readerId || String(readerId) === String(currentUserIdRef.current)) return;
      dispatchLastMessageStatusUpdate(payload, 'read');
    };
    const onMessageReadResponse = (payload) => {
      const source = unwrapPayload(payload);
      const readerId = source?.senderId || source?.readBy || source?.userId;
      if (!readerId || String(readerId) === String(currentUserIdRef.current)) return;
      dispatchLastMessageStatusUpdate(payload, 'read');
    };
    const onMessageSeen = (payload) => {
      const source = unwrapPayload(payload);
      const readerId = source?.senderId || source?.readBy || source?.userId;
      if (!readerId || String(readerId) === String(currentUserIdRef.current)) return;
      dispatchLastMessageStatusUpdate(payload, 'read');
    };
    const onPresence = (payload) => handlePresenceUpdate(payload);
    const onOnline = (payload) => handlePresenceUpdate({ ...payload, status: 'online' });
    const onOffline = (payload) => handlePresenceUpdate({ ...payload, status: 'offline' });
    const onTypingStartSocket = (payload) => handleTypingStart(payload);
    const onTypingStopSocket = (payload) => handleTypingStop(payload);

    // Group typing handlers — server broadcasts group:typing:started / group:typing:stopped
    const onGroupTypingStarted = (payload) => {
      const source = unwrapPayload(payload);
      const groupId = normalizeId(source?.groupId);
      const senderId = normalizeId(source?.senderId || source?.userId);
      if (!groupId || !senderId) return;
      // Skip own typing
      if (currentUserIdRef.current && String(senderId) === String(currentUserIdRef.current)) return;
      handleTypingStart({ chatId: groupId, senderId, userId: senderId, messageType: source?.messageType });
    };
    const onGroupTypingStopped = (payload) => {
      const source = unwrapPayload(payload);
      const groupId = normalizeId(source?.groupId);
      if (!groupId) return;
      handleTypingStop({ chatId: groupId });
    };
    const onPresenceFetchResponse = (payload) => {
      const source = unwrapPayload(payload);
      const rows = source?.users || source?.presence || source || [];
      if (!Array.isArray(rows)) return;
      rows.forEach((row) => handlePresenceUpdate(row));
    };
    const onTypingIndicator = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = source?.chatId || source?.groupId;
      if (!chatId) return;

      // Skip own typing events
      const senderId = normalizeId(source?.senderId || source?.userId);
      if (senderId && currentUserIdRef.current && String(senderId) === String(currentUserIdRef.current)) return;

      if (source?.isTyping) {
        handleTypingStart({
          chatId,
          userId: source.userId || source.senderId,
          messageType: source.messageType,
        });
      } else {
        handleTypingStop({ chatId });
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

    // Handle message edit events — update chat list preview for both sender and receiver
    const onMessageEditedForChatList = (payload) => {
      const source = payload?.data || payload || {};
      const messageId = normalizeId(source?.messageId || source?.id || source?._id);
      const newText = source?.text || source?.newText;
      const chatId = normalizeId(source?.chatId);
      if (!messageId || !chatId || !newText) return;

      // Queue as a message_edited chat list update so it goes through the reducer
      onChatListUpdate({
        type: 'message_edited',
        reason: 'message.edited',
        chatId,
        item: {
          chatId,
          messageId,
          lastMessage: {
            text: newText,
            serverMessageId: messageId,
            messageId,
            isEdited: true,
            editedAt: source?.editedAt || Date.now(),
          },
          lastMessageSender: source?.senderId || null,
          lastMessageAt: source?.createdAt || null,
          editedAt: source?.editedAt || Date.now(),
          isEdited: true,
        },
      });
    };

    // Receiver-side: scheduled message cancelled by sender — remove from chat list
    const onScheduledCancelled = (payload) => {
      const source = unwrapPayload(payload);
      const msgId = normalizeId(source?.messageId || source?._id || source?.id);
      if (msgId) {
        dispatch({ type: 'REMOVE_CANCELLED_SCHEDULED', payload: { messageId: msgId } });
      }
    };
    socket.on('message:scheduled:cancelled', onScheduledCancelled);
    socket.on('message:cancel:scheduled', onScheduledCancelled);
    socket.on('message:cancel:scheduled:response', onScheduledCancelled);

    // Handle message sent ACK — update chat list for BOTH scheduled and normal messages
    const onSentAckForChatList = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = normalizeId(source?.chatId || source?.roomId || source?.chat || source?.data?.chatId);
      const groupId = normalizeId(source?.groupId || source?.data?.groupId);
      const resolvedId = chatId || groupId;
      if (!resolvedId) return;

      // Dedup: if this message was already processed by onGroupMessageNew, skip
      const dedupId = normalizeId(source?.messageId || source?._id || source?.data?.messageId);
      if (dedupId && handledGroupMsgIdsRef.current.has(dedupId)) return;
      if (dedupId) {
        handledGroupMsgIdsRef.current.add(dedupId);
        if (handledGroupMsgIdsRef.current.size > 2000) {
          const first = handledGroupMsgIdsRef.current.values().next().value;
          handledGroupMsgIdsRef.current.delete(first);
        }
      }
      const text = source?.text || source?.data?.text || '';
      const messageId = normalizeId(source?.messageId || source?._id || source?.data?.messageId);
      const isGroup = !!(groupId || source?.chatType === 'group' || source?.data?.chatType === 'group');

      // For scheduled messages: strip schedule flags
      if (source?.isScheduled) {
        if (source) { source.isScheduled = false; source.scheduleTime = null; source.status = 'sent'; }
        if (source?.data) { source.data.isScheduled = false; source.data.scheduleTime = null; }
      }

      if (isGroup) {
        const senderName = source?.senderName || source?.data?.senderName || '';
        const messageType = source?.messageType || source?.data?.messageType || 'text';
        // Build preview text — sent ACK is always our own message, so prefix with "You:"
        let previewText = text;
        if (messageType === 'image') previewText = 'Photo';
        else if (messageType === 'video') previewText = 'Video';
        else if (messageType === 'audio') previewText = 'Audio';
        else if (messageType === 'file') previewText = 'Document';
        else if (messageType === 'location') previewText = 'Location';
        else if (messageType === 'contact') previewText = 'Contact';
        dispatch({
          type: 'INCOMING_GROUP_MESSAGE',
          payload: {
            chatId: resolvedId,
            groupId: groupId || resolvedId,
            senderId: normalizeId(source?.senderId || currentUserIdRef.current),
            senderName,
            text: `You: ${previewText}`,
            messageType,
            createdAt: source?.createdAt || source?.data?.createdAt || new Date().toISOString(),
            messageId,
            tempId: source?.tempId || source?.data?.tempId || source?.clientMessageId || source?.data?.clientMessageId,
          },
        });
      } else {
        if (source) source.status = source.status || 'sent';
        const normalized = normalizeMessagePayload(payload);
        dispatch({ type: 'INCOMING_MESSAGE', payload: normalized });
      }
    };
    socket.on('message:sent:ack', onSentAckForChatList);
    socket.on('group:message:sent', onSentAckForChatList);
    socket.on('group:message:sent:ack', onSentAckForChatList);
    socket.on('group:message:send:response', onSentAckForChatList);

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
    socket.on('group:typing:started', onGroupTypingStarted);
    socket.on('group:typing:stopped', onGroupTypingStopped);
    socket.on('group:typing:start', onGroupTypingStarted);
    socket.on('group:typing:stop', onGroupTypingStopped);
    socket.on('chat:list:update', onChatListUpdate);
    socket.on('message:edit:response', onMessageEditedForChatList);
    socket.on('message:edited', onMessageEditedForChatList);
    socket.on('chat:info:response', onChatInfoResponse);
    socket.on('chat:pin:response', onChatPinResponse);
    socket.on('chat:unpin:response', onChatUnpinResponse);
    socket.on('chat:mute:response', onChatMuteResponse);
    socket.on('chat:unmute:response', onChatUnmuteResponse);
    socket.on('chat:archive:response', onChatArchiveResponse);
    socket.on('chat:unarchive:response', onChatUnarchiveResponse);
    socket.on('chat:cleared:me', onChatCleared);
    socket.on('chat:cleared:everyone', onChatCleared);

    // ─── GROUP MESSAGE LISTENERS (chat list updates) ───

    const onGroupMessageNew = (payload) => {
      const data = payload?.data || payload;
      // Block cancelled/failed messages from updating group chat list
      if (data?.status === 'cancelled' || data?.status === 'failed') return;
      // Block scheduled/processing ONLY if scheduleTime is still in the future
      if (data?.status === 'scheduled' || data?.status === 'processing') {
        const st = data?.scheduleTime || data?.schedule_time;
        const stMs = st ? new Date(st).getTime() : 0;
        const isDeliveryNow = data?.isScheduled === false || !st || !Number.isFinite(stMs) || stMs <= Date.now() + 5000;
        if (!isDeliveryNow) return;
      }

      // Dedup: skip if already processed (prevents double unread count from new + received)
      const dedupId = normalizeId(data?.messageId || data?._id || data?.id);
      if (dedupId) {
        if (handledGroupMsgIdsRef.current.has(dedupId)) return;
        handledGroupMsgIdsRef.current.add(dedupId);
        // Evict old entries to prevent memory leak
        if (handledGroupMsgIdsRef.current.size > 2000) {
          const first = handledGroupMsgIdsRef.current.values().next().value;
          handledGroupMsgIdsRef.current.delete(first);
        }
      }

      // Block isScheduled on receiver side only if scheduleTime is still in the future
      const isSelf = data?.senderId && currentUserIdRef.current && String(data.senderId) === String(currentUserIdRef.current);
      if (!isSelf && data?.isScheduled) {
        const st = data?.scheduleTime || data?.schedule_time;
        const stMs = st ? new Date(st).getTime() : 0;
        if (Number.isFinite(stMs) && stMs > Date.now() + 5000) return;
        // scheduleTime passed — strip flags, allow through
        data.isScheduled = false;
        data.scheduleTime = null;
        data.scheduleTimeLabel = null;
      }
      const groupId = normalizeId(data?.groupId);
      const chatId = normalizeId(data?.chatId) || groupId; // fallback chatId to groupId
      if (!chatId && !groupId) return;

      const senderId = normalizeId(data?.senderId);

      // Resolve senderName: payload may not include it, so look up from group members in chatMap
      let senderName = data?.senderName || data?.sender?.fullName || '';
      if (!senderName && senderId) {
        const currentState = stateRef.current;
        const resolvedKey = (chatId && currentState.chatMap[chatId])
          ? chatId
          : (groupId && currentState.chatMap[groupId])
            ? groupId
            : findChatIdByGroupId(currentState.chatMap, groupId || chatId);
        const groupEntry = resolvedKey ? currentState.chatMap[resolvedKey] : null;
        if (groupEntry) {
          const members = Array.isArray(groupEntry.members) ? groupEntry.members : (Array.isArray(groupEntry.participants) ? groupEntry.participants : []);
          const member = members.find((m) => {
            const mId = normalizeId(m?.userId || m?._id || m?.id);
            return mId && mId === String(senderId);
          });
          senderName = member?.fullName || member?.username || member?.name || '';
        }
      }

      const text = data?.text || '';
      const messageType = data?.messageType || data?.type || 'text';
      // Handle both ISO string (createdAt) and epoch ms (sentAt) timestamps
      const rawTimestamp = data?.createdAt || data?.sentAt || data?.timestamp;
      const createdAt = rawTimestamp
        ? (typeof rawTimestamp === 'number' ? new Date(rawTimestamp).toISOString() : rawTimestamp)
        : new Date().toISOString();

      // Build preview text for chat list
      const isSystemMsg = messageType === 'system';
      let previewText = text;
      if (messageType === 'image') previewText = 'Photo';
      else if (messageType === 'video') previewText = 'Video';
      else if (messageType === 'audio') previewText = 'Audio';
      else if (messageType === 'file') previewText = 'Document';
      else if (messageType === 'location') previewText = 'Location';
      else if (messageType === 'contact') previewText = 'Contact';

      // System messages show as-is (no sender prefix)
      const fullPreview = isSystemMsg ? previewText : (senderName ? `${senderName}: ${previewText}` : previewText);

      const resolvedMessageId = normalizeId(data?.messageId || data?._id);

      dispatch({
        type: 'INCOMING_GROUP_MESSAGE',
        payload: {
          chatId,
          groupId,
          senderId,
          senderName,
          text: fullPreview,
          messageType,
          createdAt,
          messageId: resolvedMessageId,
          tempId: data?.tempId,
        },
      });

      // Persist to SQLite so messages are available when ChatScreen opens later
      if (resolvedMessageId && !isSelf) {
        const ts = rawTimestamp
          ? (typeof rawTimestamp === 'number' ? rawTimestamp : new Date(rawTimestamp).getTime())
          : Date.now();
        // Extract reply data from the payload — server may send replyTo as object or string
        const rawReplyTo = data?.replyTo;
        const replyIsObject = rawReplyTo && typeof rawReplyTo === 'object';
        const replyToMessageId = data?.replyToMessageId || data?.quotedMessageId
          || (replyIsObject ? (rawReplyTo._id || rawReplyTo.id) : rawReplyTo)
          || data?.reply_to_message_id || null;
        const replyPreviewText = data?.replyPreviewText || data?.quotedText || data?.reply_preview_text
          || (replyIsObject ? rawReplyTo.text : null) || null;
        const replyPreviewType = data?.replyPreviewType || data?.reply_preview_type
          || (replyIsObject ? (rawReplyTo.messageType || rawReplyTo.type) : null) || null;

        // Resolve reply sender name — try payload, then replyTo object, then group members
        let replySenderId = data?.replySenderId || data?.reply_sender_id
          || (replyIsObject ? (rawReplyTo.senderId || rawReplyTo.sender?._id) : null) || null;
        let replySenderName = data?.replySenderName || data?.quotedSender || data?.reply_sender_name
          || (replyIsObject ? (rawReplyTo.senderName || rawReplyTo.sender?.fullName || rawReplyTo.sender?.name) : null) || null;
        if (!replySenderName && replySenderId) {
          const currentState = stateRef.current;
          if (currentState.currentUserId && String(replySenderId) === String(currentState.currentUserId)) {
            replySenderName = 'You';
          } else if (groupEntry) {
            const mbrs = Array.isArray(groupEntry.members) ? groupEntry.members : (Array.isArray(groupEntry.participants) ? groupEntry.participants : []);
            const rm = mbrs.find((m) => {
              const mId = normalizeId(m?.userId || m?._id || m?.id);
              return mId && String(mId) === String(replySenderId);
            });
            replySenderName = rm?.fullName || rm?.username || rm?.name || null;
          }
        }

        ChatDatabase.upsertMessage({
          id: resolvedMessageId,
          serverMessageId: resolvedMessageId,
          tempId: data?.tempId || null,
          chatId: chatId || groupId,
          groupId: groupId || chatId,
          senderId,
          senderName: senderName || null,
          text: text || '',
          type: messageType || 'text',
          status: data?.status || 'sent',
          timestamp: ts,
          createdAt,
          synced: 1,
          mediaUrl: data?.mediaUrl || null,
          mediaType: data?.mediaType || null,
          replyToMessageId: replyToMessageId || null,
          replyPreviewText: replyPreviewText || null,
          replyPreviewType: replyPreviewType || null,
          replySenderName: replySenderName || null,
          replySenderId: replySenderId || null,
          contact: data?.contact ? JSON.stringify(data.contact) : null,
          forwardedFrom: data?.forwardedFrom || null,
        }).catch(() => {});

        // Save reply data to permanent reply table
        if (replyToMessageId && resolvedMessageId) {
          ChatDatabase.saveReplyData(resolvedMessageId, {
            replyToMessageId,
            replyPreviewText,
            replyPreviewType,
            replySenderName,
            replySenderId,
          }).catch(() => {});
        }

        // Update chatlist in SQLite — last message + unread count
        const chatKey = chatId || groupId;
        ChatDatabase.updateChatLastMessage(chatKey, {
          text: fullPreview,
          type: messageType,
          senderId,
          senderName,
          status: data?.status || 'sent',
          createdAt,
          serverMessageId: resolvedMessageId,
        }).catch(() => {});
        ChatDatabase.incrementChatUnread(chatKey).catch(() => {});
      }
    };

    socket.on('group:message:new', onGroupMessageNew);
    socket.on('group:message:received', onGroupMessageNew);

    // ─── GROUP MESSAGE DELETE (chat list update) ───
    // Only listen to the broadcast event (group:message:deleted).
    // group:message:delete:success is sender-only confirmation — not needed here
    // because the sender's chat screen already updated optimistically.
    const onGroupMessageDeleteForChatList = (payload) => {
      const source = payload?.data || payload;
      if (source?.status === false) return;

      const messageId = normalizeId(source?.messageId || source?._id || source?.id);
      const groupId = normalizeId(source?.groupId || source?.group?._id);
      const chatId = normalizeId(source?.chatId) || groupId;
      if (!messageId || !chatId) return;

      const isEveryoneDel = Boolean(source?.deleteForEveryone);
      if (!isEveryoneDel) return;

      const deletedBy = normalizeId(source?.deletedBy || source?.senderId || source?.userId);
      const placeholderText = deletedBy && deletedBy === state.currentUserId
        ? 'You deleted this message'
        : 'This message was deleted';

      // Update chat list preview if this was the last message
      dispatch({
        type: 'UPDATE_LAST_MESSAGE_DELETED',
        payload: { chatId, messageId, placeholderText },
      });

      // Persist message deletion to SQLite
      ChatDatabase.markMessageDeleted(messageId, deletedBy, placeholderText).catch(() => {});

      // Update SQLite chats row if this was the last message
      ChatDatabase.updateChatLastMessage(chatId, {
        text: placeholderText,
        type: 'system',
        isDeleted: true,
      }).catch(() => {});
    };
    socket.on('group:message:deleted', onGroupMessageDeleteForChatList);

    // ─── GROUP SOCKET LISTENERS ───

    // Confirmation: you successfully joined a group
    const onGroupJoined = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      console.log('📥 [GROUP] Joined group:', groupId);

      // Determine creator name for the system message
      const creatorName = data?.createdByName || data?.creatorName || data?.username || data?.fullName || '';
      const groupName = data?.groupName || data?.name || '';
      const systemText = creatorName
        ? `${creatorName} created group "${groupName || 'this group'}"`
        : `Group "${groupName || ''}" created`;

      // Show "X created this group" system message in chat list
      dispatch({
        type: 'INCOMING_GROUP_MESSAGE',
        payload: {
          chatId: groupId,
          groupId,
          senderId: null,
          senderName: null,
          text: systemText,
          messageType: 'system',
          createdAt: data?.joinedAt ? new Date(data.joinedAt).toISOString() : new Date().toISOString(),
          messageId: data?.messageId || `sys_created_${groupId}`,
        },
      });
    };

    // Confirmation: you successfully left a group
    const onGroupLeft = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      console.log('📥 [GROUP] Left group:', groupId);
      // Remove from chat list
      dispatch({ type: 'REMOVE_CHAT', payload: groupId });
    };

    // Broadcast: another member joined the group
    const onGroupMemberJoined = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      const memberName = data?.username || data?.fullName || data?.name || '';
      dispatch({
        type: 'GROUP_MEMBER_JOINED',
        payload: { groupId, userId, username: memberName, timestamp: data?.timestamp },
      });
      // Update chat list preview with system message
      dispatch({
        type: 'INCOMING_GROUP_MESSAGE',
        payload: {
          chatId: groupId,
          groupId,
          senderId: null,
          senderName: null,
          text: memberName ? `${memberName} joined` : 'A member joined',
          messageType: 'system',
          createdAt: data?.timestamp || new Date().toISOString(),
        },
      });
    };

    // Broadcast: another member left the group
    const onGroupMemberLeft = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      const memberName = data?.username || data?.fullName || data?.name || '';
      dispatch({
        type: 'GROUP_MEMBER_LEFT',
        payload: { groupId, userId },
      });
      dispatch({
        type: 'INCOMING_GROUP_MESSAGE',
        payload: {
          chatId: groupId,
          groupId,
          senderId: null,
          senderName: null,
          text: memberName ? `${memberName} left` : 'A member left',
          messageType: 'system',
          createdAt: data?.timestamp || new Date().toISOString(),
        },
      });
    };

    // Confirmation: you left all groups
    const onGroupLeaveAllSuccess = (payload) => {
      const data = payload?.data || payload;
      const leftGroupIds = Array.isArray(data?.groupIds) ? data.groupIds : [];
      console.log('📥 [GROUP] Left all groups:', data?.leftGroups || leftGroupIds.length || 0);
      // Remove specific group IDs if provided, otherwise will refresh on next hydrate
      leftGroupIds.forEach((gid) => {
        const id = normalizeId(gid);
        if (id) dispatch({ type: 'REMOVE_CHAT', payload: id });
      });
    };

    // ─── GROUP MEMBER MANAGEMENT LISTENERS ───

    // Broadcast: member was added to the group
    const onGroupMemberAdded = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      const memberName = data?.username || data?.fullName || data?.name || '';
      dispatch({
        type: 'GROUP_MEMBER_JOINED',
        payload: { groupId, userId, username: memberName, timestamp: data?.timestamp },
      });
      dispatch({
        type: 'INCOMING_GROUP_MESSAGE',
        payload: {
          chatId: groupId, groupId, senderId: null, senderName: null,
          text: memberName ? `${memberName} was added` : 'A member was added',
          messageType: 'system',
          createdAt: data?.timestamp || new Date().toISOString(),
        },
      });
    };

    // Broadcast: member was removed (kicked) from the group
    const onGroupMemberRemoved = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      const memberName = data?.username || data?.fullName || data?.name || '';
      dispatch({ type: 'GROUP_MEMBER_REMOVED', payload: { groupId, userId } });
      dispatch({
        type: 'INCOMING_GROUP_MESSAGE',
        payload: {
          chatId: groupId, groupId, senderId: null, senderName: null,
          text: memberName ? `${memberName} was removed` : 'A member was removed',
          messageType: 'system',
          createdAt: data?.timestamp || new Date().toISOString(),
        },
      });
    };

    // Personal: you were removed from a group
    const onGroupRemoved = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      console.log('📥 [GROUP] You were removed from group:', groupId);
      dispatch({ type: 'REMOVE_CHAT', payload: groupId });
    };

    // Personal: you were invited to a group
    const onGroupInvitation = (payload) => {
      const data = payload?.data || payload;
      console.log('📥 [GROUP] Invitation received for group:', data?.groupId);
      // Chat list will pick up the new group on next hydrate/refresh
    };

    // Broadcast: member was promoted to admin
    const onGroupMemberPromoted = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      console.log('📥 [GROUP] Member promoted:', userId, 'to', data?.newRole || 'admin');
      dispatch({
        type: 'GROUP_MEMBER_ROLE_CHANGED',
        payload: { groupId, userId, newRole: data?.newRole || 'admin' },
      });
    };

    // Broadcast: member was demoted from admin
    const onGroupMemberDemoted = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      console.log('📥 [GROUP] Member demoted:', userId, 'to member');
      dispatch({
        type: 'GROUP_MEMBER_ROLE_CHANGED',
        payload: { groupId, userId, newRole: 'member' },
      });
    };

    // Broadcast: member was muted
    const onGroupMemberMuted = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      console.log('📥 [GROUP] Member muted:', userId, 'till:', data?.mutedTill);
      dispatch({
        type: 'GROUP_MEMBER_MUTED',
        payload: { groupId, userId, mutedTill: data?.mutedTill },
      });
    };

    // Broadcast: member was unmuted
    const onGroupMemberUnmuted = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      const userId = normalizeId(data?.userId);
      if (!groupId || !userId) return;
      console.log('📥 [GROUP] Member unmuted:', userId);
      dispatch({
        type: 'GROUP_MEMBER_UNMUTED',
        payload: { groupId, userId },
      });
    };

    // Response: member list loaded (no-op for now — handled by Redux thunk in GroupInfo)
    const onGroupMemberListResponse = (payload) => {
      console.log('📥 [GROUP] Member list response:', payload?.data?.total || 0, 'members');
    };

    // Response: single member info (no-op for now)
    const onGroupMemberInfoResponse = (payload) => {
      console.log('📥 [GROUP] Member info response:', payload?.data?.userId);
    };

    socket.on('group:joined', onGroupJoined);
    socket.on('group:left', onGroupLeft);
    socket.on('group:member:joined', onGroupMemberJoined);
    socket.on('group:member:left', onGroupMemberLeft);
    socket.on('group:leave:all:success', onGroupLeaveAllSuccess);
    // Member management events
    socket.on('group:member:added', onGroupMemberAdded);
    socket.on('group:member:add:success', onGroupMemberAdded);
    socket.on('group:member:removed', onGroupMemberRemoved);
    socket.on('group:member:remove:success', onGroupMemberRemoved);
    socket.on('group:removed', onGroupRemoved);
    socket.on('group:invitation', onGroupInvitation);
    socket.on('group:member:promoted', onGroupMemberPromoted);
    socket.on('group:member:promote:success', onGroupMemberPromoted);
    socket.on('group:member:demoted', onGroupMemberDemoted);
    socket.on('group:member:demote:success', onGroupMemberDemoted);
    socket.on('group:admin:promoted', onGroupMemberPromoted);
    socket.on('group:admin:demoted', onGroupMemberDemoted);
    socket.on('group:member:muted', onGroupMemberMuted);
    socket.on('group:member:mute:success', onGroupMemberMuted);
    socket.on('group:muted', onGroupMemberMuted);
    socket.on('group:member:unmuted', onGroupMemberUnmuted);
    socket.on('group:member:unmute:success', onGroupMemberUnmuted);
    socket.on('group:unmuted', onGroupMemberUnmuted);
    socket.on('group:member:list:response', onGroupMemberListResponse);
    socket.on('group:member:info:response', onGroupMemberInfoResponse);

    // ─── GROUP SETTINGS & METADATA LISTENERS ───

    const onGroupSettingsUpdated = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, ...data }] });
    };

    const onGroupNameUpdated = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, groupName: data?.name, name: data?.name }] });
    };

    const onGroupDescriptionUpdated = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, description: data?.description }] });
    };

    const onGroupAvatarUpdated = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, avatar: data?.avatarUrl, profileImage: data?.avatarUrl }] });
    };

    socket.on('group:settings:updated', onGroupSettingsUpdated);
    socket.on('group:settings:response', onGroupSettingsUpdated);
    socket.on('group:settings:update:success', onGroupSettingsUpdated);
    socket.on('group:name:updated', onGroupNameUpdated);
    socket.on('group:name:update:success', onGroupNameUpdated);
    socket.on('group:description:updated', onGroupDescriptionUpdated);
    socket.on('group:description:update:success', onGroupDescriptionUpdated);
    socket.on('group:avatar:updated', onGroupAvatarUpdated);
    socket.on('group:avatar:update:success', onGroupAvatarUpdated);

    // ─── GROUP NOTIFICATION/PREFERENCE LISTENERS ───

    const onGroupMutedSuccess = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, isMuted: true, mutedTill: data?.mutedTill }] });
    };
    const onGroupUnmutedSuccess = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, isMuted: false, mutedTill: null }] });
    };
    const onGroupPinnedSuccess = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, isPinned: true }] });
    };
    const onGroupUnpinnedSuccess = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, isPinned: false }] });
    };
    const onGroupArchivedSuccess = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'ARCHIVE_CHAT', payload: groupId });
    };
    const onGroupUnarchivedSuccess = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'UNARCHIVE_CHAT', payload: groupId });
    };

    socket.on('group:muted:success', onGroupMutedSuccess);
    socket.on('group:unmuted:success', onGroupUnmutedSuccess);
    socket.on('group:pinned:success', onGroupPinnedSuccess);
    socket.on('group:unpinned:success', onGroupUnpinnedSuccess);
    socket.on('group:archived:success', onGroupArchivedSuccess);
    socket.on('group:unarchived:success', onGroupUnarchivedSuccess);

    // ─── GROUP ADMIN TRANSFER & DELETE LISTENERS ───

    const onGroupAdminTransferred = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({
        type: 'GROUP_ADMIN_TRANSFERRED',
        payload: { groupId, previousAdmin: data?.previousAdmin, newAdmin: data?.newAdmin },
      });
    };
    const onGroupDeleted = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      dispatch({ type: 'REMOVE_CHAT', payload: groupId });
    };

    socket.on('group:admin:transferred', onGroupAdminTransferred);
    socket.on('group:admin:transfer:success', onGroupAdminTransferred);
    socket.on('group:admin:received', onGroupAdminTransferred);
    socket.on('group:deleted', onGroupDeleted);
    socket.on('group:delete:success', onGroupDeleted);

    // ─── GROUP INVITATION LISTENERS ───

    const onGroupInvitationReceived = (payload) => {
      const data = payload?.data || payload;
      console.log('[GROUP] Invitation received:', data?.groupId, 'from:', data?.invitedBy);
    };
    const onGroupInviteListResponse = (payload) => {
      console.log('[GROUP] Invite list response:', payload?.data?.invites?.length || 0, 'invites');
    };

    socket.on('group:invitation:received', onGroupInvitationReceived);
    socket.on('group:invite:send:success', () => {});
    socket.on('group:invite:accept:success', () => {});
    socket.on('group:invite:reject:success', () => {});
    socket.on('group:invite:list:response', onGroupInviteListResponse);

    // ─── GROUP STATS & ACTIVITY LISTENERS ───

    const onGroupStatsResponse = (payload) => {
      console.log('[GROUP] Stats response:', payload?.data?.groupId);
    };
    const onGroupActivityResponse = (payload) => {
      console.log('[GROUP] Activity response:', payload?.data?.activities?.length || 0, 'entries');
    };

    socket.on('group:stats:response', onGroupStatsResponse);
    socket.on('group:activity:response', onGroupActivityResponse);

    // ─── GROUP MEDIA UPDATED LISTENER ───

    const onGroupMediaUpdated = (payload) => {
      const data = payload?.data || payload;
      const groupId = normalizeId(data?.groupId);
      if (!groupId) return;
      // Dispatch for chat list update if last message media changed
      dispatch({ type: 'UPDATE_CHATS_BATCH', payload: [{ chatId: groupId, ...data }] });
    };
    socket.on('group:message:media:updated', onGroupMediaUpdated);

    socketUnsubscribersRef.current = [
      () => socket.off('message:scheduled:cancelled', onScheduledCancelled),
      () => socket.off('message:cancel:scheduled', onScheduledCancelled),
      () => socket.off('message:cancel:scheduled:response', onScheduledCancelled),
      () => socket.off('message:sent:ack', onSentAckForChatList),
      () => socket.off('group:message:sent', onSentAckForChatList),
      () => socket.off('group:message:sent:ack', onSentAckForChatList),
      () => socket.off('group:message:send:response', onSentAckForChatList),
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
      () => socket.off('group:typing:started', onGroupTypingStarted),
      () => socket.off('group:typing:stopped', onGroupTypingStopped),
      () => socket.off('group:typing:start', onGroupTypingStarted),
      () => socket.off('group:typing:stop', onGroupTypingStopped),
      () => socket.off('chat:list:update', onChatListUpdate),
      () => socket.off('message:edit:response', onMessageEditedForChatList),
      () => socket.off('message:edited', onMessageEditedForChatList),
      () => socket.off('chat:info:response', onChatInfoResponse),
      () => socket.off('chat:pin:response', onChatPinResponse),
      () => socket.off('chat:unpin:response', onChatUnpinResponse),
      () => socket.off('chat:mute:response', onChatMuteResponse),
      () => socket.off('chat:unmute:response', onChatUnmuteResponse),
      () => socket.off('chat:archive:response', onChatArchiveResponse),
      () => socket.off('chat:unarchive:response', onChatUnarchiveResponse),
      () => socket.off('chat:cleared:me', onChatCleared),
      () => socket.off('chat:cleared:everyone', onChatCleared),
      () => socket.off('group:message:new', onGroupMessageNew),
      () => socket.off('group:message:received', onGroupMessageNew),
      () => socket.off('group:message:deleted', onGroupMessageDeleteForChatList),
      () => socket.off('group:joined', onGroupJoined),
      () => socket.off('group:left', onGroupLeft),
      () => socket.off('group:member:joined', onGroupMemberJoined),
      () => socket.off('group:member:left', onGroupMemberLeft),
      () => socket.off('group:leave:all:success', onGroupLeaveAllSuccess),
      () => socket.off('group:member:added', onGroupMemberAdded),
      () => socket.off('group:member:add:success', onGroupMemberAdded),
      () => socket.off('group:member:removed', onGroupMemberRemoved),
      () => socket.off('group:member:remove:success', onGroupMemberRemoved),
      () => socket.off('group:removed', onGroupRemoved),
      () => socket.off('group:invitation', onGroupInvitation),
      () => socket.off('group:member:promoted', onGroupMemberPromoted),
      () => socket.off('group:member:promote:success', onGroupMemberPromoted),
      () => socket.off('group:member:demoted', onGroupMemberDemoted),
      () => socket.off('group:member:demote:success', onGroupMemberDemoted),
      () => socket.off('group:admin:promoted', onGroupMemberPromoted),
      () => socket.off('group:admin:demoted', onGroupMemberDemoted),
      () => socket.off('group:member:muted', onGroupMemberMuted),
      () => socket.off('group:member:mute:success', onGroupMemberMuted),
      () => socket.off('group:muted', onGroupMemberMuted),
      () => socket.off('group:member:unmuted', onGroupMemberUnmuted),
      () => socket.off('group:member:unmute:success', onGroupMemberUnmuted),
      () => socket.off('group:unmuted', onGroupMemberUnmuted),
      () => socket.off('group:member:list:response', onGroupMemberListResponse),
      () => socket.off('group:member:info:response', onGroupMemberInfoResponse),
      // Settings & metadata
      () => socket.off('group:settings:updated', onGroupSettingsUpdated),
      () => socket.off('group:settings:response', onGroupSettingsUpdated),
      () => socket.off('group:settings:update:success', onGroupSettingsUpdated),
      () => socket.off('group:name:updated', onGroupNameUpdated),
      () => socket.off('group:name:update:success', onGroupNameUpdated),
      () => socket.off('group:description:updated', onGroupDescriptionUpdated),
      () => socket.off('group:description:update:success', onGroupDescriptionUpdated),
      () => socket.off('group:avatar:updated', onGroupAvatarUpdated),
      () => socket.off('group:avatar:update:success', onGroupAvatarUpdated),
      // Notification/preference
      () => socket.off('group:muted:success', onGroupMutedSuccess),
      () => socket.off('group:unmuted:success', onGroupUnmutedSuccess),
      () => socket.off('group:pinned:success', onGroupPinnedSuccess),
      () => socket.off('group:unpinned:success', onGroupUnpinnedSuccess),
      () => socket.off('group:archived:success', onGroupArchivedSuccess),
      () => socket.off('group:unarchived:success', onGroupUnarchivedSuccess),
      // Admin transfer & delete
      () => socket.off('group:admin:transferred', onGroupAdminTransferred),
      () => socket.off('group:admin:transfer:success', onGroupAdminTransferred),
      () => socket.off('group:admin:received', onGroupAdminTransferred),
      () => socket.off('group:deleted', onGroupDeleted),
      () => socket.off('group:delete:success', onGroupDeleted),
      // Invitations
      () => socket.off('group:invitation:received', onGroupInvitationReceived),
      () => socket.off('group:invite:list:response', onGroupInviteListResponse),
      // Stats & activity
      () => socket.off('group:stats:response', onGroupStatsResponse),
      () => socket.off('group:activity:response', onGroupActivityResponse),
      // Media updated
      () => socket.off('group:message:media:updated', onGroupMediaUpdated),
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

  // ─── SQLite-first chatlist loading ───
  // Load chatlist from SQLite on mount. No API call needed if data exists.
  useEffect(() => {
    let cancelled = false;

    const loadChatListFromSQLite = async () => {
      try {
        // Populate in-memory cache FIRST for instant reads
        const chats = await ChatDatabase.loadChatList({ includeArchived: true });
        if (cancelled) return;
        ChatCache.setChats(chats);
        if (chats.length > 0) {
          dispatch({ type: 'HYDRATE_CHAT_CACHE', payload: chats });
        } else {
          dispatch({ type: 'HYDRATE_CHAT_CACHE', payload: [] });
        }
      } catch {
        if (!cancelled) {
          dispatch({ type: 'HYDRATE_CHAT_CACHE', payload: [] });
        }
      }
    };

    loadChatListFromSQLite();
    return () => { cancelled = true; };
  }, []);

  // ─── Debounced SQLite chatlist save ───
  // Persist chatMap changes to SQLite chats table (replaces AsyncStorage cache)
  useEffect(() => {
    if (!state.hasHydratedCache) return;

    if (storageSaveTimerRef.current) {
      clearTimeout(storageSaveTimerRef.current);
    }

    storageSaveTimerRef.current = setTimeout(async () => {
      try {
        const chatList = buildStorageChatList(state);
        await ChatDatabase.upsertChats(chatList);
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
      ChatCache.clearAll();
      dispatch({ type: 'RESET_STATE', payload: { currentUserId: null } });
    });

    const unsubscribeUserChanged = subscribeUserChanged(({ userId }) => {
      ChatCache.clearAll();
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

  const hydrateChats = useCallback(async (chats, opts = {}) => {
    ChatCache.setChats(chats || []);
    dispatch({ type: 'HYDRATE_CHATS', payload: chats || [] });
    const tempMap = {};
    (chats || []).forEach((chat) => {
      const chatId = normalizeId(chat?.chatId || chat?._id);
      if (chatId) tempMap[chatId] = chat;
    });
    subscribePresenceForChats(tempMap);

    // Persist chatlist to SQLite (write-through on API sync / initial load)
    if (!opts.skipSQLiteWrite) {
      ChatDatabase.upsertChats(chats || []).catch(() => {});
    }

    // Sync lastMessage from SQLite — SQLite is the source of truth for message content.
    // The API/cache may have stale lastMessage (before edit/delete).
    try {
      const chatIds = Object.keys(tempMap);
      for (const chatId of chatIds) {
        // Try chatId first, then groupId for group chats
        const chat = tempMap[chatId];
        const groupId = normalizeId(chat?.groupId || chat?.group?._id);
        let latestMsg = await ChatDatabase.getLatestMessage(chatId);
        if (!latestMsg && groupId) {
          latestMsg = await ChatDatabase.getLatestMessage(groupId);
        }
        if (!latestMsg) continue;

        const apiLastMsg = tempMap[chatId]?.lastMessage;
        const apiMsgId = normalizeId(apiLastMsg?.serverMessageId || apiLastMsg?.messageId || apiLastMsg?.id || apiLastMsg?._id);
        const localMsgId = normalizeId(latestMsg.serverMessageId || latestMsg.id);

        // If SQLite has a locally edited or deleted version that the API doesn't reflect, use SQLite's
        const localIsEdited = Boolean(latestMsg.isEdited);
        const localIsDeleted = Boolean(latestMsg.isDeleted);
        const apiIsEdited = Boolean(apiLastMsg?.isEdited || apiLastMsg?.editedAt);
        const apiIsDeleted = Boolean(apiLastMsg?.isDeleted);

        const shouldOverride =
          (localIsEdited && !apiIsEdited) ||
          (localIsDeleted && !apiIsDeleted) ||
          // Also override if SQLite has a newer message than the API
          (latestMsg.timestamp && apiLastMsg?.createdAt &&
            latestMsg.timestamp > new Date(apiLastMsg.createdAt).getTime());

        if (shouldOverride) {
          dispatch({
            type: 'LOCAL_LAST_MESSAGE_OVERRIDE',
            payload: {
              chatId,
              lastMessage: {
                text: latestMsg.isDeleted ? (latestMsg.placeholderText || 'This message was deleted') : (latestMsg.text || ''),
                type: latestMsg.type || 'text',
                senderId: latestMsg.senderId || null,
                status: latestMsg.status || null,
                createdAt: latestMsg.createdAt || new Date(latestMsg.timestamp || Date.now()).toISOString(),
                serverMessageId: latestMsg.serverMessageId || latestMsg.id,
                messageId: latestMsg.serverMessageId || latestMsg.id,
                isEdited: localIsEdited,
                editedAt: latestMsg.editedAt || null,
                isDeleted: localIsDeleted,
                deletedFor: latestMsg.deletedFor || null,
                placeholderText: latestMsg.placeholderText || null,
              },
              lastMessageAt: latestMsg.createdAt || new Date(latestMsg.timestamp || Date.now()).toISOString(),
              lastMessageType: latestMsg.type || 'text',
              lastMessageSender: latestMsg.senderId || null,
              lastMessageEdited: localIsEdited,
            },
          });
        }
      }
    } catch (err) {
      console.warn('[RealtimeChat] SQLite sync after hydrate error:', err);
    }
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
    // Reset unread in SQLite
    if (chatId) ChatDatabase.updateChatUnread(chatId, 0).catch(() => {});
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

  const pinChat = useCallback((chatId, chatType) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    const nowIso = new Date().toISOString();
    applyOptimisticAction(normalizedChatId, {
      isPinned: true,
      pinnedAt: nowIso,
    });
    emitChatAction('chat:pin', { chatId: normalizedChatId, chatType: chatType || 'private' });
  }, [applyOptimisticAction, emitChatAction]);

  const unpinChat = useCallback((chatId, chatType) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isPinned: false,
      pinnedAt: null,
    });
    emitChatAction('chat:unpin', { chatId: normalizedChatId, chatType: chatType || 'private' });
  }, [applyOptimisticAction, emitChatAction]);

  const muteChat = useCallback((chatId, duration, chatType) => {
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
      chatType: chatType || 'private',
      duration: durationMs > 0 ? durationMs : undefined,
      muteUntil,
    });
  }, [applyOptimisticAction, emitChatAction]);

  const unmuteChat = useCallback((chatId, chatType) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isMuted: false,
      muteUntil: null,
    });
    emitChatAction('chat:unmute', { chatId: normalizedChatId, chatType: chatType || 'private' });
  }, [applyOptimisticAction, emitChatAction]);

  const archiveChat = useCallback((chatId, chatType) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isArchived: true,
    });
    emitChatAction('chat:archive', { chatId: normalizedChatId, chatType: chatType || 'private' });
  }, [applyOptimisticAction, emitChatAction]);

  const unarchiveChat = useCallback((chatId, chatType) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    applyOptimisticAction(normalizedChatId, {
      isArchived: false,
    });
    emitChatAction('chat:unarchive', { chatId: normalizedChatId, chatType: chatType || 'private' });
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

  // ═══════════════════════════════════════════
  // GROUP SOCKET ACTIONS
  // ═══════════════════════════════════════════

  const removeChat = useCallback((chatId) => {
    const normalizedChatId = normalizeId(chatId);
    if (!normalizedChatId) return;
    deferDispatch({ type: 'REMOVE_CHAT', payload: normalizedChatId });
  }, [deferDispatch]);

  const joinGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:join', { groupId: id });
  }, [emitChatAction]);

  const leaveGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:leave', { groupId: id });
  }, [emitChatAction]);

  const leaveAllGroups = useCallback(() => {
    emitChatAction('group:leave:all', {});
  }, [emitChatAction]);

  // ─── GROUP MEMBER MANAGEMENT EMITTERS ───

  const addGroupMembers = useCallback((groupId, userIds) => {
    const id = normalizeId(groupId);
    if (!id || !Array.isArray(userIds) || userIds.length === 0) return;
    emitChatAction('group:member:add', { groupId: id, userIds });
  }, [emitChatAction]);

  const removeGroupMember = useCallback((groupId, userId) => {
    const gid = normalizeId(groupId);
    const uid = normalizeId(userId);
    if (!gid || !uid) return;
    emitChatAction('group:member:remove', { groupId: gid, userId: uid });
  }, [emitChatAction]);

  const promoteGroupMember = useCallback((groupId, userId) => {
    const gid = normalizeId(groupId);
    const uid = normalizeId(userId);
    if (!gid || !uid) return;
    emitChatAction('group:member:promote', { groupId: gid, userId: uid });
  }, [emitChatAction]);

  const demoteGroupMember = useCallback((groupId, userId) => {
    const gid = normalizeId(groupId);
    const uid = normalizeId(userId);
    if (!gid || !uid) return;
    emitChatAction('group:member:demote', { groupId: gid, userId: uid });
  }, [emitChatAction]);

  const muteGroupMember = useCallback((groupId, userId, duration) => {
    const gid = normalizeId(groupId);
    const uid = normalizeId(userId);
    if (!gid || !uid) return;
    emitChatAction('group:member:mute', { groupId: gid, userId: uid, duration: Number(duration) || 3600 });
  }, [emitChatAction]);

  const unmuteGroupMember = useCallback((groupId, userId) => {
    const gid = normalizeId(groupId);
    const uid = normalizeId(userId);
    if (!gid || !uid) return;
    emitChatAction('group:member:unmute', { groupId: gid, userId: uid });
  }, [emitChatAction]);

  const listGroupMembers = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:member:list', { groupId: id });
  }, [emitChatAction]);

  const getGroupMemberInfo = useCallback((groupId, userId) => {
    const gid = normalizeId(groupId);
    const uid = normalizeId(userId);
    if (!gid || !uid) return;
    emitChatAction('group:member:info', { groupId: gid, userId: uid });
  }, [emitChatAction]);

  // ─── GROUP SETTINGS & METADATA EMITTERS ───

  const getGroupSettings = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:settings:get', { groupId: id });
  }, [emitChatAction]);

  const updateGroupSettings = useCallback((groupId, settings) => {
    const id = normalizeId(groupId);
    if (!id || !settings) return;
    emitChatAction('group:settings:update', { groupId: id, settings });
  }, [emitChatAction]);

  const updateGroupName = useCallback((groupId, name) => {
    const id = normalizeId(groupId);
    if (!id || !name?.trim()) return;
    emitChatAction('group:name:update', { groupId: id, name: name.trim() });
  }, [emitChatAction]);

  const updateGroupDescription = useCallback((groupId, description) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:description:update', { groupId: id, description: description || '' });
  }, [emitChatAction]);

  const updateGroupAvatar = useCallback((groupId, avatarUrl) => {
    const id = normalizeId(groupId);
    if (!id || !avatarUrl) return;
    emitChatAction('group:avatar:update', { groupId: id, avatarUrl });
  }, [emitChatAction]);

  // ─── GROUP NOTIFICATION & PREFERENCE EMITTERS (user-level) ───

  const muteGroup = useCallback((groupId, duration = 0) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:mute', { groupId: id, duration: Number(duration) || 0 });
  }, [emitChatAction]);

  const unmuteGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:unmute', { groupId: id });
  }, [emitChatAction]);

  const pinGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:pinned', { groupId: id });
  }, [emitChatAction]);

  const unpinGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:unpinned', { groupId: id });
  }, [emitChatAction]);

  const archiveGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:archive', { groupId: id });
  }, [emitChatAction]);

  const unarchiveGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:unarchive', { groupId: id });
  }, [emitChatAction]);

  // ─── GROUP ADMIN TRANSFER & DELETION EMITTERS ───

  const transferGroupAdmin = useCallback((groupId, newAdminId) => {
    const gid = normalizeId(groupId);
    const uid = normalizeId(newAdminId);
    if (!gid || !uid) return;
    emitChatAction('group:admin:transfer', { groupId: gid, newAdminId: uid });
  }, [emitChatAction]);

  const deleteGroup = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:delete', { groupId: id });
  }, [emitChatAction]);

  // ─── GROUP INVITATION EMITTERS ───

  const sendGroupInvite = useCallback((groupId, userIds) => {
    const id = normalizeId(groupId);
    if (!id || !Array.isArray(userIds) || userIds.length === 0) return;
    emitChatAction('group:invite:send', { groupId: id, userIds });
  }, [emitChatAction]);

  const acceptGroupInvite = useCallback((groupId, inviteId) => {
    const id = normalizeId(groupId);
    if (!id || !inviteId) return;
    emitChatAction('group:invite:accept', { groupId: id, inviteId });
  }, [emitChatAction]);

  const rejectGroupInvite = useCallback((groupId, inviteId) => {
    const id = normalizeId(groupId);
    if (!id || !inviteId) return;
    emitChatAction('group:invite:reject', { groupId: id, inviteId });
  }, [emitChatAction]);

  const listGroupInvites = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:invite:list', { groupId: id });
  }, [emitChatAction]);

  // ─── GROUP STATS & ACTIVITY EMITTERS ───

  const getGroupStats = useCallback((groupId) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:stats', { groupId: id });
  }, [emitChatAction]);

  const getGroupActivity = useCallback((groupId, limit = 20, offset = 0) => {
    const id = normalizeId(groupId);
    if (!id) return;
    emitChatAction('group:activity', { groupId: id, limit, offset });
  }, [emitChatAction]);

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
        typingUserName: typing?.userName || null,
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
        typingUserName: typing?.userName || null,
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
    // Group actions
    joinGroup,
    leaveGroup,
    leaveAllGroups,
    removeChat,
    // Group member management
    addGroupMembers,
    removeGroupMember,
    promoteGroupMember,
    demoteGroupMember,
    muteGroupMember,
    unmuteGroupMember,
    listGroupMembers,
    getGroupMemberInfo,
    // Group settings & metadata
    getGroupSettings,
    updateGroupSettings,
    updateGroupName,
    updateGroupDescription,
    updateGroupAvatar,
    // Group notification preferences (user-level)
    muteGroup,
    unmuteGroup,
    pinGroup,
    unpinGroup,
    archiveGroup,
    unarchiveGroup,
    // Group admin & deletion
    transferGroupAdmin,
    deleteGroup,
    // Group invitations
    sendGroupInvite,
    acceptGroupInvite,
    rejectGroupInvite,
    listGroupInvites,
    // Group stats & activity
    getGroupStats,
    getGroupActivity,
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
    joinGroup,
    leaveGroup,
    leaveAllGroups,
    removeChat,
    addGroupMembers,
    removeGroupMember,
    promoteGroupMember,
    demoteGroupMember,
    muteGroupMember,
    unmuteGroupMember,
    listGroupMembers,
    getGroupMemberInfo,
    getGroupSettings,
    updateGroupSettings,
    updateGroupName,
    updateGroupDescription,
    updateGroupAvatar,
    muteGroup,
    unmuteGroup,
    pinGroup,
    unpinGroup,
    archiveGroup,
    unarchiveGroup,
    transferGroupAdmin,
    deleteGroup,
    sendGroupInvite,
    acceptGroupInvite,
    rejectGroupInvite,
    listGroupInvites,
    getGroupStats,
    getGroupActivity,
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