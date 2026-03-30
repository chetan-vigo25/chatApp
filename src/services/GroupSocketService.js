/**
 * GroupSocketService
 *
 * Handles all group-specific real-time messaging via Socket.IO.
 *
 * Events emitted (client -> server):
 *   group:message:send              – Send a message to a group
 *   group:message:edit              – Edit a message you sent
 *   group:message:delete            – Delete a message (for self or everyone)
 *   group:message:read              – Mark messages as read
 *   group:message:delivered         – Acknowledge delivery
 *   group:message:sync              – Fetch missed messages (pagination)
 *   group:message:reaction          – Add or remove emoji reaction
 *   group:message:schedule          – Schedule a message for future delivery
 *   group:message:cancel:scheduled  – Cancel a pending scheduled message
 *   group:message:read:bulk         – Mark multiple messages as read (max 100)
 *   group:message:read:all          – Mark all unread messages as read
 *   group:message:seen              – Lightweight seen analytics
 *   group:message:fetch             – Fetch messages with pagination
 *   group:message:fetch:unread      – Fetch only unread messages
 *   group:message:search            – Full-text search in group messages
 *   group:message:search:media      – Filter messages by media type
 *   group:message:forward           – Forward a single message
 *   group:message:forward:multiple  – Forward multiple messages
 *   group:message:reply             – Reply to a specific message
 *   group:message:quote             – Quote a message with inline snapshot
 *   group:message:clear:history     – Clear chat history for current user
 *   group:message:media:update      – Update media download status
 *
 * Events listened (server -> client):
 *   group:message:new               – New message broadcast
 *   group:message:received          – New message broadcast (alternative)
 *   group:message:edited            – Message edited broadcast
 *   group:message:deleted           – Message deleted broadcast
 *   group:message:read:update       – Read receipts update
 *   group:message:delivered:update  – Delivery receipts update
 *   group:message:delivered:receipt – Delivery receipt confirmation
 *   group:message:sync:response     – Sync response with missed messages
 *   group:message:reaction:update   – Reaction added/removed broadcast
 *   group:message:reaction          – Reaction broadcast (alternative)
 *   group:message:media:updated     – Media download status broadcast
 *   group:message:schedule:failed   – Scheduled message delivery failed
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

// ─── EMIT: group:message:schedule ───────────────────────
/**
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string} params.text
 * @param {string} params.scheduleTime  ISO date string (must be in the future)
 * @param {string} [params.messageType='text']
 * @param {string} [params.mediaUrl]
 * @param {Object} [params.mediaMeta]
 * @param {Function} [ack]
 */
export const scheduleGroupMessage = (params, ack) => {
  const { groupId, text, scheduleTime, messageType = 'text', mediaUrl, mediaMeta } = params;
  if (!groupId || !text?.trim() || !scheduleTime) return false;
  const payload = { groupId, text: text.trim(), messageType, scheduleTime };
  if (mediaUrl) payload.mediaUrl = mediaUrl;
  if (mediaMeta) payload.mediaMeta = mediaMeta;
  return emitSocketEvent('group:message:schedule', payload, ack);
};

// ─── EMIT: group:message:cancel:scheduled ───────────────
/**
 * @param {string} messageId
 * @param {string} [groupId]
 * @param {Function} [ack]
 */
export const cancelScheduledGroupMessage = (messageId, groupId, ack) => {
  if (!messageId) return false;
  const payload = { messageId };
  if (groupId) payload.groupId = groupId;
  return emitSocketEvent('group:message:cancel:scheduled', payload, ack);
};

// ─── EMIT: group:message:read:bulk ──────────────────────
/**
 * @param {string} groupId
 * @param {string[]} messageIds  (max 100)
 */
export const bulkReadGroupMessages = (groupId, messageIds) => {
  if (!groupId || !messageIds?.length) return false;
  return emitSocketEvent('group:message:read:bulk', { groupId, messageIds: messageIds.slice(0, 100) });
};

// ─── EMIT: group:message:read:all ───────────────────────
/**
 * @param {string} groupId
 */
export const markAllGroupRead = (groupId) => {
  if (!groupId) return false;
  return emitSocketEvent('group:message:read:all', { groupId });
};

// ─── EMIT: group:message:seen ───────────────────────────
/**
 * @param {string} groupId
 * @param {string} messageId
 */
export const markGroupMessageSeen = (groupId, messageId) => {
  if (!groupId || !messageId) return false;
  return emitSocketEvent('group:message:seen', { groupId, messageId });
};

// ─── EMIT: group:message:fetch ──────────────────────────
/**
 * @param {Object} params
 * @param {string} params.groupId
 * @param {number} [params.offset=0]
 * @param {number} [params.limit=50]
 * @param {string} [params.before]   ISO date
 * @param {string} [params.after]    ISO date
 * @param {Function} [ack]
 */
export const fetchGroupMessages = (params, ack) => {
  const { groupId, offset = 0, limit = 50, before, after } = params;
  if (!groupId) return false;
  const payload = { groupId, offset, limit };
  if (before) payload.before = before;
  if (after) payload.after = after;
  return emitSocketEvent('group:message:fetch', payload, ack);
};

// ─── EMIT: group:message:fetch:unread ───────────────────
/**
 * @param {string} groupId
 * @param {number} [limit=50]
 * @param {Function} [ack]
 */
export const fetchGroupUnread = (groupId, limit = 50, ack) => {
  if (!groupId) return false;
  return emitSocketEvent('group:message:fetch:unread', { groupId, limit }, ack);
};

// ─── EMIT: group:message:search ─────────────────────────
/**
 * @param {string} groupId
 * @param {string} query   1-200 chars
 * @param {number} [limit=50]
 * @param {Function} [ack]
 */
export const searchGroupMessages = (groupId, query, limit = 50, ack) => {
  if (!groupId || !query?.trim()) return false;
  return emitSocketEvent('group:message:search', { groupId, query: query.trim(), limit }, ack);
};

// ─── EMIT: group:message:search:media ───────────────────
/**
 * @param {string} groupId
 * @param {string} mediaType  image|video|audio|file|location
 * @param {number} [limit=50]
 * @param {Function} [ack]
 */
export const searchGroupMedia = (groupId, mediaType, limit = 50, ack) => {
  if (!groupId || !mediaType) return false;
  return emitSocketEvent('group:message:search:media', { groupId, mediaType, limit }, ack);
};

// ─── EMIT: group:message:forward ────────────────────────
/**
 * @param {Object} params
 * @param {string} params.groupId          source group
 * @param {string} params.messageId        message to forward
 * @param {string[]} [params.targetGroupIds]  max 20
 * @param {string[]} [params.targetUserIds]   max 20
 * @param {Function} [ack]
 */
export const forwardGroupMessage = (params, ack) => {
  const { groupId, messageId, targetGroupIds = [], targetUserIds = [] } = params;
  if (!groupId || !messageId) return false;
  if (targetGroupIds.length === 0 && targetUserIds.length === 0) return false;
  return emitSocketEvent('group:message:forward', {
    groupId, messageId,
    targetGroupIds: targetGroupIds.slice(0, 20),
    targetUserIds: targetUserIds.slice(0, 20),
  }, ack);
};

// ─── EMIT: group:message:forward:multiple ───────────────
/**
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string[]} params.messageIds      max 10
 * @param {string[]} [params.targetGroupIds]  max 10
 * @param {string[]} [params.targetUserIds]   max 10
 * @param {Function} [ack]
 */
export const forwardMultipleGroupMessages = (params, ack) => {
  const { groupId, messageIds = [], targetGroupIds = [], targetUserIds = [] } = params;
  if (!groupId || !messageIds.length) return false;
  if (targetGroupIds.length === 0 && targetUserIds.length === 0) return false;
  return emitSocketEvent('group:message:forward:multiple', {
    groupId,
    messageIds: messageIds.slice(0, 10),
    targetGroupIds: targetGroupIds.slice(0, 10),
    targetUserIds: targetUserIds.slice(0, 10),
  }, ack);
};

// ─── EMIT: group:message:reply ──────────────────────────
/**
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string} params.text
 * @param {string} params.replyToMessageId
 * @param {string} [params.messageType='text']
 * @param {string} [params.mediaUrl]
 * @param {string} [params.mediaThumbnailUrl]
 * @param {Object} [params.mediaMeta]
 * @param {Object} [params.contact]
 * @param {Function} [ack]
 */
export const replyToGroupMessage = (params, ack) => {
  const { groupId, text, replyToMessageId, messageType = 'text', mediaUrl, mediaThumbnailUrl, mediaMeta, contact } = params;
  if (!groupId || !replyToMessageId) return false;
  const payload = { groupId, text: (text || '').trim(), messageType, replyToMessageId };
  if (mediaUrl) payload.mediaUrl = mediaUrl;
  if (mediaThumbnailUrl) payload.mediaThumbnailUrl = mediaThumbnailUrl;
  if (mediaMeta) payload.mediaMeta = mediaMeta;
  if (contact) payload.contact = contact;
  return emitSocketEvent('group:message:reply', payload, ack);
};

// ─── EMIT: group:message:quote ──────────────────────────
/**
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string} params.text
 * @param {string} params.quotedMessageId
 * @param {string} params.quotedText
 * @param {string} params.quotedSender
 * @param {string} [params.messageType='text']
 * @param {string} [params.mediaUrl]
 * @param {string} [params.mediaThumbnailUrl]
 * @param {Object} [params.mediaMeta]
 * @param {Object} [params.contact]
 * @param {Function} [ack]
 */
export const quoteGroupMessage = (params, ack) => {
  const { groupId, text, quotedMessageId, quotedText, quotedSender, messageType = 'text', mediaUrl, mediaThumbnailUrl, mediaMeta, contact } = params;
  if (!groupId || !quotedMessageId) return false;
  const payload = { groupId, text: (text || '').trim(), messageType, quotedMessageId, quotedText, quotedSender };
  if (mediaUrl) payload.mediaUrl = mediaUrl;
  if (mediaThumbnailUrl) payload.mediaThumbnailUrl = mediaThumbnailUrl;
  if (mediaMeta) payload.mediaMeta = mediaMeta;
  if (contact) payload.contact = contact;
  return emitSocketEvent('group:message:quote', payload, ack);
};

// ─── EMIT: group:message:clear:history ──────────────────
/**
 * @param {string} groupId
 * @param {Function} [ack]
 */
export const clearGroupHistory = (groupId, ack) => {
  if (!groupId) return false;
  return emitSocketEvent('group:message:clear:history', { groupId }, ack);
};

// ─── EMIT: group:message:media:update ───────────────────
/**
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string} params.messageId
 * @param {boolean} params.isMediaDownloaded
 * @param {string} [params.messageType]
 * @param {string} [params.mediaId]
 * @param {string} [params.deviceId]
 * @param {Function} [ack]
 */
export const updateGroupMessageMedia = (params, ack) => {
  const { groupId, messageId, isMediaDownloaded, messageType, mediaId, deviceId } = params;
  if (!groupId || !messageId) return false;
  const payload = { groupId, messageId, isMediaDownloaded: Boolean(isMediaDownloaded) };
  if (messageType) payload.messageType = messageType;
  if (mediaId) payload.mediaId = mediaId;
  if (deviceId) payload.deviceId = deviceId;
  return emitSocketEvent('group:message:media:update', payload, ack);
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
 * @param {Function} handlers.onMediaUpdated        ({ groupId, messageId, isMediaDownloaded, ... }) =>
 * @param {Function} handlers.onScheduleFailed      ({ messageId, groupId }) =>
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
    onMediaUpdated,
    onScheduleFailed,
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

  // ── group:message:media:updated ──
  const handleMediaUpdated = (payload) => {
    const data = payload?.data || payload;
    onMediaUpdated?.({
      groupId: data?.groupId,
      messageId: data?.messageId || data?._id,
      messageType: data?.messageType,
      isMediaDownloaded: data?.isMediaDownloaded,
      updatedAt: data?.updatedAt,
      updatedBy: data?.updatedBy,
      deviceId: data?.deviceId,
    });
  };

  // ── group:message:schedule:failed ──
  const handleScheduleFailed = (payload) => {
    const data = payload?.data || payload;
    onScheduleFailed?.({
      messageId: data?.messageId || data?._id,
      groupId: data?.groupId,
    });
  };

  // Bind listeners
  socket.on('group:message:new', handleNewMessage);
  socket.on('group:message:received', handleNewMessage);
  socket.on('group:message:edited', handleEdited);
  socket.on('group:message:deleted', handleDeleted);
  socket.on('group:message:read:update', handleReadUpdate);
  socket.on('group:message:delivered:update', handleDeliveredUpdate);
  socket.on('group:message:delivered:receipt', handleDeliveredUpdate);
  socket.on('group:message:sync:response', handleSyncResponse);
  socket.on('group:message:reaction:update', handleReactionUpdate);
  socket.on('group:message:reaction', handleReactionUpdate);
  socket.on('group:message:media:updated', handleMediaUpdated);
  socket.on('group:message:schedule:failed', handleScheduleFailed);

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
    socket.off('group:message:received', handleNewMessage);
    socket.off('group:message:edited', handleEdited);
    socket.off('group:message:deleted', handleDeleted);
    socket.off('group:message:read:update', handleReadUpdate);
    socket.off('group:message:delivered:update', handleDeliveredUpdate);
    socket.off('group:message:delivered:receipt', handleDeliveredUpdate);
    socket.off('group:message:sync:response', handleSyncResponse);
    socket.off('group:message:reaction:update', handleReactionUpdate);
    socket.off('group:message:reaction', handleReactionUpdate);
    socket.off('group:message:media:updated', handleMediaUpdated);
    socket.off('group:message:schedule:failed', handleScheduleFailed);
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
  // Emitters — core messaging
  sendGroupMessage,
  editGroupMessage,
  deleteGroupMessage,
  markGroupMessagesRead,
  markGroupMessagesDelivered,
  syncGroupMessages,
  reactToGroupMessage,
  // Emitters — scheduled messages
  scheduleGroupMessage,
  cancelScheduledGroupMessage,
  // Emitters — read/seen
  bulkReadGroupMessages,
  markAllGroupRead,
  markGroupMessageSeen,
  // Emitters — fetch/search
  fetchGroupMessages,
  fetchGroupUnread,
  searchGroupMessages,
  searchGroupMedia,
  // Emitters — forward
  forwardGroupMessage,
  forwardMultipleGroupMessages,
  // Emitters — reply/quote
  replyToGroupMessage,
  quoteGroupMessage,
  // Emitters — history/media
  clearGroupHistory,
  updateGroupMessageMedia,
  // Listeners
  attachGroupMessageListeners,
  // Utilities
  withAutoDelivery,
  generateGroupMessageId,
  clearDedupCache,
};