import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';

const TYPING_TTL = 10000;
const CHAT_HIGHLIGHT_TTL = 2000;
const CHAT_UPDATE_BATCH_WINDOW = 90;

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
    const tsA = toTimestamp(chatA.lastMessageAt || chatA?.lastMessage?.createdAt || chatA?.updatedAt);
    const tsB = toTimestamp(chatB.lastMessageAt || chatB?.lastMessage?.createdAt || chatB?.updatedAt);
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
  const chatId = source?.chatId || item?.chatId || item?._id || null;

  if (!chatId) return null;

  return {
    chatId,
    type,
    reason,
    item,
    timestamp: Number(source?.timestamp || item?.lastMessageAt || Date.now()),
  };
};

const buildLastMessageFromItem = (existingChat, item, fallbackTimestamp) => {
  const baseLastMessage = existingChat?.lastMessage || {};
  const messageText =
    item?.lastMessage?.text ||
    item?.lastMessage ||
    item?.text ||
    baseLastMessage?.text ||
    '';

  const status =
    item?.lastMessageStatus ||
    item?.status ||
    item?.lastMessage?.status ||
    baseLastMessage?.status ||
    null;

  return {
    ...baseLastMessage,
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
    chatId: message?.chatId || message?.roomId || message?.chat || source?.chatId || source?.roomId || source?.chat,
    createdAt: message?.createdAt || message?.timestamp || source?.createdAt || new Date().toISOString(),
    senderId: message?.senderId || source?.senderId || source?.from || null,
    text: message?.text || message?.content || source?.text || source?.content || '',
  };
};

const normalizePresencePayload = (payload = {}) => {
  const source = unwrapPayload(payload);
  const candidate = source?.presence || source?.userPresence || source?.presenceData || source?.user || source;
  const userId = source?.userId || candidate?.userId || candidate?.id || null;
  return { userId, presence: candidate };
};

const normalizeTypingPayload = (payload = {}) => {
  const source = unwrapPayload(payload);
  return {
    chatId: source?.chatId || source?.roomId || source?.chat || null,
    userId: source?.senderId || source?.userId || source?.from || null,
    messageType: source?.messageType || null,
  };
};

const reducer = (state, action) => {
  switch (action.type) {
    case 'SET_CURRENT_USER': {
      return { ...state, currentUserId: action.payload || null };
    }

    case 'HYDRATE_CHATS': {
      const incoming = Array.isArray(action.payload) ? action.payload : [];
      const nextMap = { ...state.chatMap };

      incoming.forEach((chat) => {
        const chatId = chat?.chatId || chat?._id;
        if (!chatId) return;

        const prev = nextMap[chatId] || {};
        const prevUnread = state.unreadByChat[chatId];
        const unreadCount = typeof prevUnread === 'number' ? prevUnread : Number(chat?.unreadCount || 0);

        nextMap[chatId] = {
          ...prev,
          ...chat,
          _id: chat?._id || chatId,
          chatId,
          unreadCount,
          lastMessageAt: chat?.lastMessageAt || prev?.lastMessageAt || chat?.lastMessage?.createdAt || prev?.lastMessage?.createdAt,
        };
      });

      const sections = buildOrderedSections(nextMap);
      const unreadByChat = { ...state.unreadByChat };
      Object.keys(nextMap).forEach((id) => {
        if (typeof unreadByChat[id] !== 'number') {
          unreadByChat[id] = Number(nextMap[id]?.unreadCount || 0);
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
      const chatId = message.chatId || message.roomId || message.chat;
      if (!chatId) return state;

      const existing = state.chatMap[chatId] || {
        _id: chatId,
        chatId,
      };

      const lastMessageAt = message.createdAt || new Date().toISOString();
      const lastMessage = {
        ...(existing.lastMessage || {}),
        text: message.text || message.content || existing?.lastMessage?.text || '',
        createdAt: lastMessageAt,
        senderId: message.senderId,
      };

      const isIncoming = Boolean(
        message.senderId &&
        state.currentUserId &&
        String(message.senderId) !== String(state.currentUserId)
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
          _id: existing._id || chatId,
          lastMessage,
          lastMessageAt,
          unreadCount: Number(unreadByChat[chatId] || 0),
        },
      };

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
          [chatId]: Date.now(),
        },
        totalUnread: recomputeTotalUnread(unreadByChat),
      };
    }

    case 'OUTGOING_MESSAGE': {
      const message = action.payload || {};
      const chatId = message.chatId;
      if (!chatId) return state;

      const existing = state.chatMap[chatId] || { _id: chatId, chatId };
      const lastMessageAt = message.createdAt || new Date().toISOString();
      const lastMessage = {
        ...(existing.lastMessage || {}),
        text: message.text || existing?.lastMessage?.text || '',
        createdAt: lastMessageAt,
        senderId: message.senderId,
      };

      const nextMap = {
        ...state.chatMap,
        [chatId]: {
          ...existing,
          chatId,
          _id: existing._id || chatId,
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
      const chatId = payload.chatId;
      if (!chatId) return state;

      const existing = state.chatMap[chatId] || { _id: chatId, chatId };
      const nextMap = {
        ...state.chatMap,
        [chatId]: {
          ...existing,
          chatId,
          _id: existing._id || chatId,
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
      const chatId = action.payload;
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
        const existing = nextMap[chatId] || { _id: chatId, chatId };

        const mergedBase = {
          ...existing,
          ...item,
          _id: item?._id || existing?._id || chatId,
          chatId,
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
              lastMessageStatus: lastMessage?.status || mergedBase?.lastMessageStatus || 'sent',
              unreadCount: unreadByChat[chatId],
            };

            highlightByChat[chatId] = Date.now();
            break;
          }

          case 'message_read': {
            unreadByChat[chatId] = 0;
            const lastMessage = {
              ...(existing?.lastMessage || {}),
              status: 'read',
            };

            nextMap[chatId] = {
              ...mergedBase,
              lastMessage,
              lastMessageStatus: 'read',
              unreadCount: 0,
            };

            delete highlightByChat[chatId];
            break;
          }

          case 'message_delivered': {
            const lastMessage = {
              ...(existing?.lastMessage || {}),
              status: 'delivered',
            };

            nextMap[chatId] = {
              ...mergedBase,
              lastMessage,
              lastMessageStatus: 'delivered',
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
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_unpinned': {
            nextMap[chatId] = {
              ...mergedBase,
              isPinned: false,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_muted': {
            nextMap[chatId] = {
              ...mergedBase,
              isMuted: true,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
            break;
          }

          case 'chat_unmuted': {
            nextMap[chatId] = {
              ...mergedBase,
              isMuted: false,
              unreadCount: Number(unreadByChat[chatId] || existing?.unreadCount || 0),
            };
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
    const onMessageRead = (payload) => {
      const source = unwrapPayload(payload);
      const chatId = source?.chatId || source?.roomId || source?.chat || null;
      if (chatId) dispatch({ type: 'MARK_READ', payload: chatId });
    };
    const onPresence = (payload) => handlePresenceUpdate(payload);
    const onOnline = (payload) => handlePresenceUpdate({ ...payload, status: 'online' });
    const onOffline = (payload) => handlePresenceUpdate({ ...payload, status: 'offline' });
    const onTypingStartSocket = (payload) => handleTypingStart(payload);
    const onTypingStopSocket = (payload) => handleTypingStop(payload);
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

    socket.on('message:new', onMessage);
    socket.on('message:received', onMessage);
    socket.on('message:read', onMessageRead);

    socket.on('presence:update', onPresence);
    socket.on('presence:subscribed:update', onPresence);
    socket.on('presence:get:response', onPresence);
    socket.on('presence:fetch:response', (payload) => {
      const source = unwrapPayload(payload);
      const rows = source?.users || source?.presence || source || [];
      if (!Array.isArray(rows)) return;
      rows.forEach((row) => handlePresenceUpdate(row));
    });
    socket.on('user:online', onOnline);
    socket.on('user:offline', onOffline);

    socket.on('typing:start', onTypingStartSocket);
    socket.on('typing:stop', onTypingStopSocket);
    socket.on('typing:indicator', onTypingIndicator);
    socket.on('chat:list:update', onChatListUpdate);

    socketUnsubscribersRef.current = [
      () => socket.off('message:new', onMessage),
      () => socket.off('message:received', onMessage),
      () => socket.off('message:read', onMessageRead),
      () => socket.off('presence:update', onPresence),
      () => socket.off('presence:subscribed:update', onPresence),
      () => socket.off('presence:get:response', onPresence),
      () => socket.off('presence:fetch:response'),
      () => socket.off('user:online', onOnline),
      () => socket.off('user:offline', onOffline),
      () => socket.off('typing:start', onTypingStartSocket),
      () => socket.off('typing:stop', onTypingStopSocket),
      () => socket.off('typing:indicator', onTypingIndicator),
      () => socket.off('chat:list:update', onChatListUpdate),
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
      detachSocketListeners();
      Object.keys(typingTimersRef.current).forEach((chatId) => clearTypingTimer(chatId));
      Object.keys(chatHighlightTimersRef.current).forEach((chatId) => {
        clearTimeout(chatHighlightTimersRef.current[chatId]);
      });
      chatHighlightTimersRef.current = {};
    };
  }, [attachSocketListeners, clearTypingTimer, detachSocketListeners]);

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

  const hydrateChats = useCallback((chats) => {
    dispatch({ type: 'HYDRATE_CHATS', payload: chats || [] });
    const tempMap = {};
    (chats || []).forEach((chat) => {
      const chatId = chat?.chatId || chat?._id;
      if (chatId) tempMap[chatId] = chat;
    });
    subscribePresenceForChats(tempMap);
  }, [subscribePresenceForChats]);

  const setActiveChat = useCallback((chatId) => {
    dispatch({ type: 'SET_ACTIVE_CHAT', payload: chatId || null });
    if (chatId) {
      const socket = getSocket();
      if (socket && isSocketConnected()) {
        socket.emit('message:read', { chatId });
      }
    }
  }, []);

  const markChatRead = useCallback((chatId) => {
    dispatch({ type: 'MARK_READ', payload: chatId });
  }, []);

  const onLocalOutgoingMessage = useCallback((message) => {
    dispatch({ type: 'OUTGOING_MESSAGE', payload: message });
  }, []);

  const updateLocalLastMessagePreview = useCallback((payload) => {
    dispatch({ type: 'LOCAL_LAST_MESSAGE_OVERRIDE', payload });
  }, []);

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
  }), [state, chatList, archivedChatList, hydrateChats, setActiveChat, markChatRead, onLocalOutgoingMessage, updateLocalLastMessagePreview]);

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
