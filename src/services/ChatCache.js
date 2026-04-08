/**
 * ChatCache — High-performance in-memory cache for instant chat rendering.
 *
 * Architecture:
 *   Memory Cache (instant) → SQLite (persistent) → API (background sync)
 *
 * The cache stores:
 *   1. Chat list   — sorted, ready-to-render chat entries
 *   2. Messages    — per-chat, capped at MAX_MESSAGES_PER_CHAT
 *   3. Metadata    — unread counts, typing states, last access times
 *
 * All reads are synchronous (Map lookups). Writes are synchronous to memory
 * and async to SQLite in the background.
 */

// ─── Configuration ─────────────────────────────────────
const MAX_MESSAGES_PER_CHAT = 50;
const MAX_CACHED_CHATS_MESSAGES = 20; // Keep messages in memory for up to N chats
const EVICTION_CHECK_INTERVAL = 60000; // 1 minute

// ─── In-Memory Stores ──────────────────────────────────

// Chat list: chatId → chat object (same shape as RealtimeChatContext chatMap)
const chatMap = new Map();

// Sorted chat IDs (maintained on every write)
let sortedChatIds = [];

// Messages: chatId → { messages: [], lastAccess: timestamp }
const messageStore = new Map();

// Pending writes queue (batched SQLite writes)
const pendingChatWrites = new Set();
const pendingMessageWrites = new Map(); // chatId → Set<messageId>

// Hydration flags
let isChatListHydrated = false;
let hydratedMessageChats = new Set();

// Eviction timer
let evictionTimer = null;

// ─── Chat List Cache ───────────────────────────────────

/**
 * Get the full chat list, sorted by last activity.
 * Returns immediately from memory — never blocks.
 */
export const getChats = () => {
  return sortedChatIds.map(id => chatMap.get(id)).filter(Boolean);
};

/**
 * Get a single chat by ID.
 */
export const getChat = (chatId) => {
  return chatId ? chatMap.get(String(chatId)) || null : null;
};

/**
 * Hydrate the chat list from an array of chat objects.
 * Called once on app start from SQLite, then on API sync.
 */
export const setChats = (chats) => {
  if (!Array.isArray(chats) || chats.length === 0) return;

  for (const chat of chats) {
    const id = String(chat.chatId || chat._id || chat.id);
    if (!id) continue;
    const existing = chatMap.get(id);
    // Merge: preserve local fields (typing, unread) if they exist
    chatMap.set(id, existing ? { ...existing, ...chat, chatId: id } : { ...chat, chatId: id });
  }

  rebuildSortedIds();
  isChatListHydrated = true;
};

/**
 * Update a single chat entry (e.g., new message arrived, status change).
 */
export const updateChat = (chatId, updates) => {
  if (!chatId) return;
  const id = String(chatId);
  const existing = chatMap.get(id);
  if (existing) {
    chatMap.set(id, { ...existing, ...updates });
  } else {
    chatMap.set(id, { ...updates, chatId: id });
  }
  rebuildSortedIds();
  pendingChatWrites.add(id);
};

/**
 * Remove a chat from cache.
 */
export const removeChat = (chatId) => {
  if (!chatId) return;
  const id = String(chatId);
  chatMap.delete(id);
  messageStore.delete(id);
  hydratedMessageChats.delete(id);
  rebuildSortedIds();
};

/**
 * Check if chat list has been loaded into memory.
 */
export const isChatListReady = () => isChatListHydrated;

/**
 * Get the total number of cached chats.
 */
export const getChatCount = () => chatMap.size;

// ─── Messages Cache ────────────────────────────────────

/**
 * Get messages for a chat. Returns immediately from memory.
 * Returns empty array if not cached (caller should load from SQLite).
 */
export const getMessages = (chatId) => {
  if (!chatId) return [];
  const id = String(chatId);
  const entry = messageStore.get(id);
  if (entry) {
    entry.lastAccess = Date.now();
    return entry.messages;
  }
  return [];
};

/**
 * Check if messages for a chat are in memory cache.
 */
export const hasMessages = (chatId) => {
  return chatId ? messageStore.has(String(chatId)) : false;
};

/**
 * Set the full message list for a chat (initial load from SQLite/API).
 * Messages should be sorted newest-first (descending timestamp).
 */
export const setMessages = (chatId, messages) => {
  if (!chatId || !Array.isArray(messages)) return;
  const id = String(chatId);

  // Cap at max messages
  const capped = messages.length > MAX_MESSAGES_PER_CHAT
    ? messages.slice(0, MAX_MESSAGES_PER_CHAT)
    : messages;

  messageStore.set(id, {
    messages: capped,
    lastAccess: Date.now(),
  });
  hydratedMessageChats.add(id);

  // Trigger eviction check if too many chats cached
  scheduleEviction();
};

/**
 * Add a single new message to a chat (real-time incoming or sent).
 * Inserts at position 0 (newest first), deduplicates, and caps.
 */
export const addMessage = (chatId, message) => {
  if (!chatId || !message) return;
  const id = String(chatId);

  let entry = messageStore.get(id);
  if (!entry) {
    entry = { messages: [], lastAccess: Date.now() };
    messageStore.set(id, entry);
  }
  entry.lastAccess = Date.now();

  const msgId = message.serverMessageId || message.id || message.tempId;

  // Dedup: check if message already exists
  const existingIdx = entry.messages.findIndex(m =>
    (msgId && (m.id === msgId || m.serverMessageId === msgId || m.tempId === msgId)) ||
    (message.tempId && (m.id === message.tempId || m.tempId === message.tempId))
  );

  if (existingIdx !== -1) {
    // Update existing message (e.g., temp → server ID, status change)
    entry.messages[existingIdx] = { ...entry.messages[existingIdx], ...message };
  } else {
    // Insert at beginning (newest first)
    entry.messages.unshift(message);

    // Evict oldest if over limit
    if (entry.messages.length > MAX_MESSAGES_PER_CHAT) {
      entry.messages = entry.messages.slice(0, MAX_MESSAGES_PER_CHAT);
    }
  }
};

/**
 * Update a specific message in cache (status change, edit, reaction, etc.).
 */
export const updateMessage = (chatId, messageId, updates) => {
  if (!chatId || !messageId) return false;
  const id = String(chatId).trim();
  const mid = String(messageId).trim();

  const entry = messageStore.get(id);
  if (!entry) return false;

  const idx = entry.messages.findIndex(m =>
    String(m.id || '').trim() === mid ||
    String(m.serverMessageId || '').trim() === mid ||
    String(m.tempId || '').trim() === mid
  );

  if (idx === -1) return false;
  entry.messages[idx] = { ...entry.messages[idx], ...updates };
  return true;
};

/**
 * Remove a message from cache.
 */
export const removeMessage = (chatId, messageId) => {
  if (!chatId || !messageId) return;
  const id = String(chatId).trim();
  const mid = String(messageId).trim();
  const entry = messageStore.get(id);
  if (!entry) return;
  entry.messages = entry.messages.filter(m =>
    String(m.id || '').trim() !== mid &&
    String(m.serverMessageId || '').trim() !== mid &&
    String(m.tempId || '').trim() !== mid
  );
};

/**
 * Clear messages cache for a specific chat.
 */
export const clearMessages = (chatId) => {
  if (!chatId) return;
  const id = String(chatId);
  messageStore.delete(id);
  hydratedMessageChats.delete(id);
};

/**
 * Check if messages for this chat have been hydrated from SQLite.
 */
export const isMessageCacheHydrated = (chatId) => {
  return chatId ? hydratedMessageChats.has(String(chatId)) : false;
};

// ─── Batch Update Helpers ──────────────────────────────

/**
 * Update multiple messages at once (e.g., mark as read).
 */
export const bulkUpdateMessages = (chatId, messageIds, updates) => {
  if (!chatId || !Array.isArray(messageIds)) return;
  const id = String(chatId);
  const entry = messageStore.get(id);
  if (!entry) return;

  const idSet = new Set(messageIds.map(String));
  entry.messages = entry.messages.map(m => {
    const mid = String(m.serverMessageId || m.id || m.tempId || '');
    if (idSet.has(mid)) return { ...m, ...updates };
    return m;
  });
};

/**
 * Merge messages from SQLite/API into cache without losing local-only data.
 * Used after refreshMessagesFromDB.
 */
export const mergeMessages = (chatId, dbMessages) => {
  if (!chatId || !Array.isArray(dbMessages)) return;
  const id = String(chatId);

  const entry = messageStore.get(id);
  if (!entry) {
    // No existing cache — just set
    setMessages(id, dbMessages);
    return;
  }

  // Build lookup of existing messages by ID for preserving local-only state
  const localById = new Map();
  for (const m of entry.messages) {
    if (m.id) localById.set(String(m.id).trim(), m);
    if (m.serverMessageId) localById.set(String(m.serverMessageId).trim(), m);
    if (m.tempId) localById.set(String(m.tempId).trim(), m);
  }

  // Merge: prefer DB data but preserve local-only fields (reactions, reply preview)
  const merged = dbMessages.map(dbMsg => {
    const localMsg = localById.get(String(dbMsg.id).trim())
      || localById.get(String(dbMsg.serverMessageId).trim())
      || localById.get(String(dbMsg.tempId).trim());
    if (!localMsg) return dbMsg;

    // Preserve local data that DB might not have yet
    const patch = {};
    if (!dbMsg.replyPreviewText && localMsg.replyPreviewText) {
      patch.replyPreviewText = localMsg.replyPreviewText;
      patch.replyPreviewType = localMsg.replyPreviewType;
      patch.replySenderName = localMsg.replySenderName;
      patch.replySenderId = localMsg.replySenderId;
    }
    if (!dbMsg.senderName && localMsg.senderName) patch.senderName = localMsg.senderName;
    // ALWAYS prefer local reactions (optimistic updates are more fresh than DB)
    // This prevents flickering where reactions briefly disappear
    if (localMsg.reactions && typeof localMsg.reactions === 'object' && Object.keys(localMsg.reactions).length > 0) {
      patch.reactions = localMsg.reactions;
    }

    return Object.keys(patch).length > 0 ? { ...dbMsg, ...patch } : dbMsg;
  });

  // Keep temp messages not yet in DB
  const dbIdSet = new Set();
  for (const m of merged) {
    if (m.id) dbIdSet.add(String(m.id));
    if (m.serverMessageId) dbIdSet.add(String(m.serverMessageId));
    if (m.tempId) dbIdSet.add(String(m.tempId));
  }
  const localOnly = entry.messages.filter(m => {
    const mid = m.id || m.tempId;
    if (!mid || !String(mid).startsWith('temp_')) return false;
    return !dbIdSet.has(String(m.id)) && !dbIdSet.has(String(m.tempId)) && !dbIdSet.has(String(m.serverMessageId));
  });

  const combined = [...localOnly, ...merged]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, MAX_MESSAGES_PER_CHAT);

  entry.messages = combined;
  entry.lastAccess = Date.now();
  hydratedMessageChats.add(id);
};

// ─── Memory Management ─────────────────────────────────

/**
 * Evict message caches for least-recently-accessed chats.
 * Keeps the MAX_CACHED_CHATS_MESSAGES most recent.
 */
const evictStaleMessageCaches = () => {
  if (messageStore.size <= MAX_CACHED_CHATS_MESSAGES) return;

  const entries = [...messageStore.entries()]
    .sort((a, b) => b[1].lastAccess - a[1].lastAccess);

  // Keep the most recently accessed, evict the rest
  const toEvict = entries.slice(MAX_CACHED_CHATS_MESSAGES);
  for (const [chatId] of toEvict) {
    messageStore.delete(chatId);
    hydratedMessageChats.delete(chatId);
  }
};

const scheduleEviction = () => {
  if (evictionTimer) return;
  evictionTimer = setTimeout(() => {
    evictionTimer = null;
    evictStaleMessageCaches();
  }, EVICTION_CHECK_INTERVAL);
};

// ─── Internal Helpers ──────────────────────────────────

const rebuildSortedIds = () => {
  sortedChatIds = [...chatMap.entries()]
    .sort((a, b) => {
      const chatA = a[1];
      const chatB = b[1];
      // Pinned first
      if (chatA.isPinned && !chatB.isPinned) return -1;
      if (!chatA.isPinned && chatB.isPinned) return 1;
      // Then by last message time (newest first)
      const timeA = chatA.lastMessageAt ? new Date(chatA.lastMessageAt).getTime() : (chatA.timestamp ? new Date(chatA.timestamp).getTime() : 0);
      const timeB = chatB.lastMessageAt ? new Date(chatB.lastMessageAt).getTime() : (chatB.timestamp ? new Date(chatB.timestamp).getTime() : 0);
      return timeB - timeA;
    })
    .map(([id]) => id);
};

// ─── Cache Lifecycle ───────────────────────────────────

/**
 * Clear all caches (e.g., on logout).
 */
export const clearAll = () => {
  chatMap.clear();
  messageStore.clear();
  hydratedMessageChats.clear();
  pendingChatWrites.clear();
  pendingMessageWrites.clear();
  sortedChatIds = [];
  isChatListHydrated = false;
  if (evictionTimer) {
    clearTimeout(evictionTimer);
    evictionTimer = null;
  }
};

/**
 * Get cache stats for debugging.
 */
export const getStats = () => ({
  totalChats: chatMap.size,
  cachedMessageChats: messageStore.size,
  hydratedMessageChats: hydratedMessageChats.size,
  totalCachedMessages: [...messageStore.values()].reduce((sum, e) => sum + e.messages.length, 0),
  isChatListHydrated,
});

// ─── Default Export ────────────────────────────────────

const ChatCache = {
  // Chat list
  getChats,
  getChat,
  setChats,
  updateChat,
  removeChat,
  isChatListReady,
  getChatCount,

  // Messages
  getMessages,
  hasMessages,
  setMessages,
  addMessage,
  updateMessage,
  removeMessage,
  clearMessages,
  isMessageCacheHydrated,
  mergeMessages,
  bulkUpdateMessages,

  // Lifecycle
  clearAll,
  getStats,
};

export default ChatCache;
