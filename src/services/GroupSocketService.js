/**
 * GroupSocketService
 *
 * Handles all group-specific real-time messaging via Socket.IO.
 *
 * Events emitted (client -> server):
 *   group:message:send        – Send a message to a group
 *   group:message:edit        – Edit a message you sent
 *   group:message:delete      – Delete a message (for self or everyone)
 *   group:message:read        – Mark messages as read
 *   group:message:delivered   – Acknowledge delivery
 *   group:message:sync        – Fetch missed messages (pagination)
 *   group:message:reaction    – Add or remove emoji reaction
 *
 * Events listened (server -> client):
 *   group:message:new         – New message broadcast
 *   group:message:edited      – Message edited broadcast
 *   group:message:deleted     – Message deleted broadcast
 *   group:message:read:update – Read receipts update
 *   group:message:delivered:update – Delivery receipts update
 *   group:message:sync:response   – Sync response with missed messages
 *   group:message:reaction:update – Reaction added/removed broadcast
 */

import { getSocket, isSocketConnected, emitSocketEvent } from '../Redux/Services/Socket/socket';

// ─── Dedup ───────────────────────────────────────────────
const processedMessageIds = new Set();
const DEDUP_CACHE_MAX = 2000;

const isDuplicate = (messageId) => {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  if (processedMessageIds.size >= DEDUP_CACHE_MAX) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
  processedMessageIds.add(messageId);
  return false;
};

export const clearDedupCache = () => processedMessageIds.clear();

// ─── Client ID generator ────────────────────────────────
export const generateGroupMessageId = () =>
  `grp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

// ─── EMIT: group:message:send ───────────────────────────
/**
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string} params.text
 * @param {string} [params.messageType='text']  text|image|video|audio|file|location|contact
 * @param {string} [params.mediaUrl]
 * @param {Object} [params.mediaMeta]
 * @param {string} [params.replyTo]       messageId being replied to
 * @param {string} [params.forwardedFrom] original messageId
 * @param {string} [params.tempId]        client-side dedup key
 * @param {Function} [ack]                server acknowledgement callback
 */
export const sendGroupMessage = (params, ack) => {
  const {
    groupId,
    text = '',
    messageType = 'text',
    mediaUrl = '',
    mediaMeta = {},
    replyTo = null,
    forwardedFrom = null,
    tempId = generateGroupMessageId(),
    senderId,
  } = params;

  if (!groupId) {
    console.warn('[GroupSocket] sendGroupMessage: missing groupId');
    return false;
  }

  const payload = {
    groupId,
    text: text.trim(),
    messageType,
    mediaUrl,
    mediaMeta,
    replyTo,
    forwardedFrom,
    tempId,
    senderId,
    createdAt: new Date().toISOString(),
  };

  return emitSocketEvent('group:message:send', payload, (response) => {
    if (response?.messageId) {
      // Track server-assigned ID for dedup
      isDuplicate(response.messageId);
    }
    ack?.(response);
  });
};

// ─── EMIT: group:message:edit ───────────────────────────
/**
 * @param {string} groupId
 * @param {string} messageId
 * @param {string} newText
 * @param {Function} [ack]
 */
export const editGroupMessage = (groupId, messageId, newText, ack) => {
  if (!groupId || !messageId || !newText?.trim()) return false;

  return emitSocketEvent('group:message:edit', {
    groupId,
    messageId,
    text: newText.trim(),
    editedAt: new Date().toISOString(),
  }, ack);
};

// ─── EMIT: group:message:delete ─────────────────────────
/**
 * @param {string} groupId
 * @param {string} messageId
 * @param {'me'|'everyone'} deleteFor
 * @param {Function} [ack]
 */
export const deleteGroupMessage = (groupId, messageId, deleteFor = 'me', ack) => {
  if (!groupId || !messageId) return false;

  return emitSocketEvent('group:message:delete', {
    groupId,
    messageId,
    deleteFor,
  }, ack);
};

// ─── EMIT: group:message:read ───────────────────────────
/**
 * @param {string} groupId
 * @param {string[]} messageIds - IDs of messages the user has read
 * @param {string} userId       - the reader
 */
export const markGroupMessagesRead = (groupId, messageIds, userId) => {
  if (!groupId || !messageIds?.length || !userId) return false;

  return emitSocketEvent('group:message:read', {
    groupId,
    messageIds,
    userId,
    readAt: new Date().toISOString(),
  });
};

// ─── EMIT: group:message:delivered ──────────────────────
/**
 * @param {string} groupId
 * @param {string[]} messageIds
 * @param {string} userId
 */
export const markGroupMessagesDelivered = (groupId, messageIds, userId) => {
  if (!groupId || !messageIds?.length || !userId) return false;

  return emitSocketEvent('group:message:delivered', {
    groupId,
    messageIds,
    userId,
    deliveredAt: new Date().toISOString(),
  });
};

// ─── EMIT: group:message:sync ───────────────────────────
/**
 * Fetches missed messages with cursor-based pagination.
 *
 * @param {string}   groupId
 * @param {string}   [lastMessageId]  cursor – omit for latest
 * @param {number}   [limit=50]
 * @param {Function} [ack]
 */
export const syncGroupMessages = (groupId, lastMessageId = null, limit = 50, ack) => {
  if (!groupId) return false;

  return emitSocketEvent('group:message:sync', {
    groupId,
    lastMessageId,
    limit,
  }, ack);
};

// ─── EMIT: group:message:reaction ───────────────────────
/**
 * @param {string} groupId
 * @param {string} messageId
 * @param {string} emoji       e.g. 'heart', 'thumbsup', 'laughing'
 * @param {'add'|'remove'} action
 * @param {string} userId
 */
export const reactToGroupMessage = (groupId, messageId, emoji, action = 'add', userId) => {
  if (!groupId || !messageId || !emoji || !userId) return false;

  return emitSocketEvent('group:message:reaction', {
    groupId,
    messageId,
    emoji,
    action,
    userId,
  });
};

// ─── LISTENER MANAGER ───────────────────────────────────
/**
 * Attaches all group message listeners to the socket.
 * Returns a cleanup function that removes all listeners.
 *
 * @param {Object} handlers
 * @param {Function} handlers.onNewMessage         (message) =>
 * @param {Function} handlers.onMessageEdited       ({ groupId, messageId, text, editedAt }) =>
 * @param {Function} handlers.onMessageDeleted      ({ groupId, messageId, deleteFor, deletedBy }) =>
 * @param {Function} handlers.onReadUpdate          ({ groupId, messageIds, userId, readAt }) =>
 * @param {Function} handlers.onDeliveredUpdate     ({ groupId, messageIds, userId, deliveredAt }) =>
 * @param {Function} handlers.onSyncResponse        ({ groupId, messages, hasMore, nextCursor }) =>
 * @param {Function} handlers.onReactionUpdate      ({ groupId, messageId, emoji, action, userId, reactions }) =>
 * @returns {Function} unsubscribe
 */
export const attachGroupMessageListeners = (handlers = {}) => {
  const socket = getSocket();
  if (!socket) {
    console.warn('[GroupSocket] attachGroupMessageListeners: socket not available');
    return () => {};
  }

  const {
    onNewMessage,
    onMessageEdited,
    onMessageDeleted,
    onReadUpdate,
    onDeliveredUpdate,
    onSyncResponse,
    onReactionUpdate,
  } = handlers;

  // ── group:message:new ──
  const handleNewMessage = (payload) => {
    const data = payload?.data || payload;
    const messageId = data?.messageId || data?._id;

    // Dedup: skip if already processed
    if (isDuplicate(messageId)) return;

    onNewMessage?.({
      messageId,
      groupId: data?.groupId,
      senderId: data?.senderId,
      senderName: data?.senderName || data?.sender?.fullName,
      senderAvatar: data?.senderAvatar || data?.sender?.profileImage,
      text: data?.text || '',
      messageType: data?.messageType || 'text',
      mediaUrl: data?.mediaUrl || '',
      mediaMeta: data?.mediaMeta || {},
      replyTo: data?.replyTo || null,
      forwardedFrom: data?.forwardedFrom || null,
      tempId: data?.tempId,
      createdAt: data?.createdAt || new Date().toISOString(),
      timestamp: data?.timestamp || Date.now(),
    });
  };

  // ── group:message:edited ──
  const handleEdited = (payload) => {
    const data = payload?.data || payload;
    onMessageEdited?.({
      groupId: data?.groupId,
      messageId: data?.messageId || data?._id,
      text: data?.text,
      editedAt: data?.editedAt,
      editedBy: data?.editedBy || data?.senderId,
    });
  };

  // ── group:message:deleted ──
  const handleDeleted = (payload) => {
    const data = payload?.data || payload;
    onMessageDeleted?.({
      groupId: data?.groupId,
      messageId: data?.messageId || data?._id,
      deleteFor: data?.deleteFor || 'everyone',
      deletedBy: data?.deletedBy || data?.senderId,
      deletedAt: data?.deletedAt,
    });
  };

  // ── group:message:read:update ──
  const handleReadUpdate = (payload) => {
    const data = payload?.data || payload;
    onReadUpdate?.({
      groupId: data?.groupId,
      messageIds: data?.messageIds || [data?.messageId].filter(Boolean),
      userId: data?.userId,
      readAt: data?.readAt,
    });
  };

  // ── group:message:delivered:update ──
  const handleDeliveredUpdate = (payload) => {
    const data = payload?.data || payload;
    onDeliveredUpdate?.({
      groupId: data?.groupId,
      messageIds: data?.messageIds || [data?.messageId].filter(Boolean),
      userId: data?.userId,
      deliveredAt: data?.deliveredAt,
    });
  };

  // ── group:message:sync:response ──
  const handleSyncResponse = (payload) => {
    const data = payload?.data || payload;
    const messages = Array.isArray(data?.messages) ? data.messages : [];

    // Dedup each synced message
    const uniqueMessages = messages.filter((msg) => {
      const id = msg?.messageId || msg?._id;
      return !isDuplicate(id);
    });

    onSyncResponse?.({
      groupId: data?.groupId,
      messages: uniqueMessages,
      hasMore: data?.hasMore ?? (messages.length >= (data?.limit || 50)),
      nextCursor: data?.nextCursor || data?.lastMessageId || null,
      total: data?.total,
    });
  };

  // ── group:message:reaction:update ──
  const handleReactionUpdate = (payload) => {
    const data = payload?.data || payload;
    onReactionUpdate?.({
      groupId: data?.groupId,
      messageId: data?.messageId || data?._id,
      emoji: data?.emoji,
      action: data?.action,
      userId: data?.userId,
      // Full reactions map: { emoji: { count, users: [userId, ...] } }
      reactions: data?.reactions || null,
    });
  };

  // Bind listeners
  socket.on('group:message:new', handleNewMessage);
  socket.on('group:message:edited', handleEdited);
  socket.on('group:message:deleted', handleDeleted);
  socket.on('group:message:read:update', handleReadUpdate);
  socket.on('group:message:delivered:update', handleDeliveredUpdate);
  socket.on('group:message:sync:response', handleSyncResponse);
  socket.on('group:message:reaction:update', handleReactionUpdate);

  // Also listen for generic message events that might be group messages
  const handleGenericNew = (payload) => {
    const data = payload?.data || payload;
    if (data?.groupId && data?.chatType === 'group') {
      handleNewMessage(payload);
    }
  };
  socket.on('message:new', handleGenericNew);

  // Cleanup function
  return () => {
    socket.off('group:message:new', handleNewMessage);
    socket.off('group:message:edited', handleEdited);
    socket.off('group:message:deleted', handleDeleted);
    socket.off('group:message:read:update', handleReadUpdate);
    socket.off('group:message:delivered:update', handleDeliveredUpdate);
    socket.off('group:message:sync:response', handleSyncResponse);
    socket.off('group:message:reaction:update', handleReactionUpdate);
    socket.off('message:new', handleGenericNew);
  };
};

// ─── CONVENIENCE: Auto-deliver on receive ───────────────
/**
 * Automatically emits delivery receipt when a new group message arrives.
 * Wrap your onNewMessage handler with this.
 *
 * @param {string} currentUserId
 * @param {Function} originalHandler
 * @returns {Function}
 */
export const withAutoDelivery = (currentUserId, originalHandler) => {
  return (message) => {
    // Don't send delivery receipt for own messages
    if (message?.senderId !== currentUserId && message?.groupId && message?.messageId) {
      markGroupMessagesDelivered(message.groupId, [message.messageId], currentUserId);
    }
    originalHandler?.(message);
  };
};

export default {
  // Emitters
  sendGroupMessage,
  editGroupMessage,
  deleteGroupMessage,
  markGroupMessagesRead,
  markGroupMessagesDelivered,
  syncGroupMessages,
  reactToGroupMessage,
  // Listeners
  attachGroupMessageListeners,
  // Utilities
  withAutoDelivery,
  generateGroupMessageId,
  clearDedupCache,
};
