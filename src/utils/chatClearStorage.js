import AsyncStorage from '@react-native-async-storage/async-storage';
import localStorageService from '../services/LocalStorageService';

const CHAT_MESSAGES_PREFIX = 'chat_messages_';
const CHAT_CLEARED_AT_PREFIX = 'chat_cleared_at_';
const CHAT_LIST_CACHE_KEY = 'CHAT_LIST_CACHE';

const CHAT_OBJECT_CACHE_KEYS = [
  'messagesByChatId',
  'messageIndex',
  'mediaCache',
  'replyCache',
  'chatCache',
];

const EXTRA_CHAT_KEYS = [
  'chat_message_index_',
  'chat_media_cache_',
  'chat_reply_references_',
  'chat_media_index_',
  'chat_reply_refs_',
  'chat_deleted_tombstones_',
];

export const normalizeChatStorageId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const candidate = value?._id?.$oid || value?._id || value?.id || value?.chatId || null;
    return candidate == null ? null : String(candidate);
  }
  return null;
};

export const getChatMessagesKey = (chatId) => {
  const normalized = normalizeChatStorageId(chatId);
  return normalized ? `${CHAT_MESSAGES_PREFIX}${normalized}` : null;
};

export const getChatClearedAtKey = (chatId) => {
  const normalized = normalizeChatStorageId(chatId);
  return normalized ? `${CHAT_CLEARED_AT_PREFIX}${normalized}` : null;
};

export const markChatClearedAt = async (chatId, timestamp = Date.now()) => {
  const key = getChatClearedAtKey(chatId);
  if (!key) return;
  await AsyncStorage.setItem(key, String(Number(timestamp || Date.now())));
};

export const getChatClearedAt = async (chatId) => {
  const key = getChatClearedAtKey(chatId);
  if (!key) return 0;
  const raw = await AsyncStorage.getItem(key);
  const value = Number(raw || 0);
  return Number.isFinite(value) ? value : 0;
};

export const isMessageBeforeChatClear = async (chatId, messageTimestamp) => {
  const clearedAt = await getChatClearedAt(chatId);
  if (!clearedAt) return false;
  const ts = Number(messageTimestamp || 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts <= clearedAt;
};

export const clearChatLocalArtifacts = async (chatId, options = {}) => {
  const normalized = normalizeChatStorageId(chatId);
  if (!normalized) return;

  const { markCleared = true } = options;

  const keysToRemove = EXTRA_CHAT_KEYS.map((prefix) => `${prefix}${normalized}`);
  const messageKey = getChatMessagesKey(normalized);
  await AsyncStorage.multiRemove(messageKey ? [...keysToRemove, messageKey] : keysToRemove);

  // Clean chat-scoped object caches if they exist in storage.
  await Promise.all(CHAT_OBJECT_CACHE_KEYS.map(async (cacheKey) => {
    try {
      const raw = await AsyncStorage.getItem(cacheKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      if (cacheKey === 'chatCache' && parsed[normalized]) {
        parsed[normalized] = {
          ...(parsed[normalized] || {}),
          messages: [],
          lastMessage: null,
          unreadCount: 0,
          updatedAt: Date.now(),
        };
      } else if (parsed[normalized] !== undefined) {
        delete parsed[normalized];
      }

      await AsyncStorage.setItem(cacheKey, JSON.stringify(parsed));
    } catch {
      // best effort
    }
  }));

  // Keep chat list entry but clear preview/unread as requested.
  try {
    const raw = await AsyncStorage.getItem(CHAT_LIST_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const next = parsed.map((row) => {
          const rowId = normalizeChatStorageId(row?.chatId || row?._id);
          if (rowId !== normalized) return row;
          return {
            ...row,
            lastMessage: null,
            lastMessageAt: null,
            lastMessageType: 'text',
            lastMessageSender: null,
            unreadCount: 0,
            updatedAt: new Date().toISOString(),
          };
        });
        await AsyncStorage.setItem(CHAT_LIST_CACHE_KEY, JSON.stringify(next));
      }
    }
  } catch {
    // best effort
  }

  // Remove chat media files and download queue items tracked in LocalStorageService.
  try {
    await localStorageService.clearMediaByChatId(normalized);
  } catch {
    // best effort
  }

  // Optional MMKV cleanup if the app has an MMKV store available at runtime.
  try {
    // eslint-disable-next-line global-require
    const mmkvModule = require('react-native-mmkv');
    if (mmkvModule?.MMKV) {
      const storage = new mmkvModule.MMKV();
      const mmkvKeys = [
        ...EXTRA_CHAT_KEYS.map((prefix) => `${prefix}${normalized}`),
        `${CHAT_MESSAGES_PREFIX}${normalized}`,
      ];
      mmkvKeys.forEach((key) => {
        try {
          storage.delete(key);
        } catch {
          // noop
        }
      });
    }
  } catch {
    // MMKV not installed/available for this runtime
  }

  // Keep an explicit tombstone timestamp so older socket/local messages are ignored.
  await markChatClearedAt(normalized);

  if (!markCleared) {
    await AsyncStorage.removeItem(getChatClearedAtKey(normalized));
  }
};

export const removeMessagesByChatId = async (chatId) => {
  await clearChatLocalArtifacts(chatId, { markCleared: true });
};