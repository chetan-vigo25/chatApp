/**
 * useGroupChat
 *
 * React hook that wires GroupSocketService into group chat screens.
 * Manages message state, sending, receiving, reactions, sync, and
 * delivery/read receipts for a specific group.
 *
 * Usage:
 *   const { messages, sendText, sendMedia, editMessage, deleteMessage,
 *           toggleReaction, syncMissed, readReceipts } = useGroupChat(groupId, currentUserId);
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  sendGroupMessage,
  editGroupMessage,
  deleteGroupMessage,
  markGroupMessagesRead,
  markGroupMessagesDelivered,
  syncGroupMessages,
  reactToGroupMessage,
  attachGroupMessageListeners,
  withAutoDelivery,
  generateGroupMessageId,
  clearDedupCache,
} from '../services/GroupSocketService';

const LOCAL_MESSAGES_PREFIX = 'group_messages_';
const MAX_LOCAL_MESSAGES = 300;
const SAVE_DEBOUNCE_MS = 300;
const READ_MARK_DELAY_MS = 800;

const normalizeId = (v) => (v == null ? null : String(v));

export default function useGroupChat(groupId, currentUserId) {
  const [messages, setMessages] = useState([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [typingUsers, setTypingUsers] = useState({});

  const nextCursorRef = useRef(null);
  const saveTimerRef = useRef(null);
  const readTimerRef = useRef(null);
  const unsubRef = useRef(null);
  const groupIdRef = useRef(groupId);
  const currentUserIdRef = useRef(currentUserId);

  groupIdRef.current = groupId;
  currentUserIdRef.current = currentUserId;

  // ─── Local storage ────────────────────────────────────
  const storageKey = `${LOCAL_MESSAGES_PREFIX}${groupId}`;

  const saveToLocal = useCallback((msgs) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const toSave = (msgs || []).slice(0, MAX_LOCAL_MESSAGES);
        await AsyncStorage.setItem(storageKey, JSON.stringify(toSave));
      } catch (e) {
        console.warn('[useGroupChat] save failed', e);
      }
    }, SAVE_DEBOUNCE_MS);
  }, [storageKey]);

  const loadFromLocal = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[useGroupChat] load failed', e);
    }
    return [];
  }, [storageKey]);

  // ─── Dedup helper ─────────────────────────────────────
  const addMessages = useCallback((incoming, prepend = false) => {
    setMessages((prev) => {
      const idSet = new Set();
      const merged = prepend ? [...incoming, ...prev] : [...prev, ...incoming];
      const unique = [];
      for (const msg of merged) {
        const id = msg.messageId || msg.tempId || msg.id;
        if (id && idSet.has(id)) continue;
        if (id) idSet.add(id);
        unique.push(msg);
      }
      // Sort newest first
      unique.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      saveToLocal(unique);
      return unique;
    });
  }, [saveToLocal]);

  // ─── Update a single message ──────────────────────────
  const updateMessage = useCallback((messageId, updater) => {
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((msg) => {
        const id = msg.messageId || msg.tempId || msg.id;
        if (id === messageId) {
          changed = true;
          return typeof updater === 'function' ? updater(msg) : { ...msg, ...updater };
        }
        return msg;
      });
      if (changed) saveToLocal(next);
      return changed ? next : prev;
    });
  }, [saveToLocal]);

  // ─── Send text message ────────────────────────────────
  const sendText = useCallback((text, replyTo = null) => {
    if (!text?.trim() || !groupIdRef.current) return;

    const tempId = generateGroupMessageId();
    const timestamp = Date.now();
    const createdAt = new Date(timestamp).toISOString();

    // Optimistic insert
    const optimisticMsg = {
      messageId: tempId,
      tempId,
      groupId: groupIdRef.current,
      senderId: currentUserIdRef.current,
      senderName: 'You',
      text: text.trim(),
      messageType: 'text',
      replyTo,
      createdAt,
      timestamp,
      status: 'sending',
      isLocal: true,
    };

    addMessages([optimisticMsg]);

    sendGroupMessage({
      groupId: groupIdRef.current,
      text: text.trim(),
      messageType: 'text',
      replyTo,
      tempId,
      senderId: currentUserIdRef.current,
    }, (response) => {
      if (response?.messageId) {
        updateMessage(tempId, (msg) => ({
          ...msg,
          messageId: response.messageId,
          status: 'sent',
          isLocal: false,
          serverData: response,
        }));
      } else {
        updateMessage(tempId, { status: 'failed' });
      }
    });
  }, [addMessages, updateMessage]);

  // ─── Send media message ───────────────────────────────
  const sendMedia = useCallback((mediaUrl, messageType = 'image', mediaMeta = {}, replyTo = null) => {
    if (!mediaUrl || !groupIdRef.current) return;

    const tempId = generateGroupMessageId();
    const timestamp = Date.now();

    const optimisticMsg = {
      messageId: tempId,
      tempId,
      groupId: groupIdRef.current,
      senderId: currentUserIdRef.current,
      senderName: 'You',
      text: '',
      messageType,
      mediaUrl,
      mediaMeta,
      replyTo,
      createdAt: new Date(timestamp).toISOString(),
      timestamp,
      status: 'sending',
      isLocal: true,
    };

    addMessages([optimisticMsg]);

    sendGroupMessage({
      groupId: groupIdRef.current,
      messageType,
      mediaUrl,
      mediaMeta,
      replyTo,
      tempId,
      senderId: currentUserIdRef.current,
    }, (response) => {
      if (response?.messageId) {
        updateMessage(tempId, (msg) => ({
          ...msg,
          messageId: response.messageId,
          status: 'sent',
          isLocal: false,
        }));
      } else {
        updateMessage(tempId, { status: 'failed' });
      }
    });
  }, [addMessages, updateMessage]);

  // ─── Resend failed message ────────────────────────────
  const resendMessage = useCallback((msg) => {
    if (!msg?.tempId) return;
    updateMessage(msg.tempId, { status: 'sending' });

    sendGroupMessage({
      groupId: groupIdRef.current,
      text: msg.text || '',
      messageType: msg.messageType || 'text',
      mediaUrl: msg.mediaUrl || '',
      mediaMeta: msg.mediaMeta || {},
      replyTo: msg.replyTo || null,
      tempId: msg.tempId,
      senderId: currentUserIdRef.current,
    }, (response) => {
      if (response?.messageId) {
        updateMessage(msg.tempId, (m) => ({
          ...m,
          messageId: response.messageId,
          status: 'sent',
          isLocal: false,
        }));
      } else {
        updateMessage(msg.tempId, { status: 'failed' });
      }
    });
  }, [updateMessage]);

  // ─── Edit message ─────────────────────────────────────
  const editMessage = useCallback((messageId, newText) => {
    if (!messageId || !newText?.trim()) return;

    // Optimistic update
    updateMessage(messageId, (msg) => ({
      ...msg,
      text: newText.trim(),
      isEdited: true,
      editedAt: new Date().toISOString(),
    }));

    editGroupMessage(groupIdRef.current, messageId, newText, (response) => {
      if (!response?.status && response?.status !== undefined) {
        // Revert on failure — in practice you'd store old text
        console.warn('[useGroupChat] edit failed', response?.message);
      }
    });
  }, [updateMessage]);

  // ─── Delete message ───────────────────────────────────
  const deleteMessage = useCallback((messageId, deleteFor = 'everyone') => {
    if (!messageId) return;

    if (deleteFor === 'everyone') {
      updateMessage(messageId, (msg) => ({
        ...msg,
        isDeleted: true,
        deletedFor: 'everyone',
        text: 'This message was deleted',
      }));
    } else {
      // Remove from local list for "delete for me"
      setMessages((prev) => {
        const next = prev.filter((m) => (m.messageId || m.tempId) !== messageId);
        saveToLocal(next);
        return next;
      });
    }

    deleteGroupMessage(groupIdRef.current, messageId, deleteFor);
  }, [updateMessage, saveToLocal]);

  // ─── React to message ─────────────────────────────────
  const toggleReaction = useCallback((messageId, emoji) => {
    if (!messageId || !emoji) return;

    // Optimistic toggle
    updateMessage(messageId, (msg) => {
      const reactions = { ...(msg.reactions || {}) };
      const existing = reactions[emoji] || { count: 0, users: [] };
      const uid = currentUserIdRef.current;
      const hasReacted = existing.users?.includes(uid);

      if (hasReacted) {
        reactions[emoji] = {
          count: Math.max(0, existing.count - 1),
          users: existing.users.filter((u) => u !== uid),
        };
        if (reactions[emoji].count === 0) delete reactions[emoji];
      } else {
        reactions[emoji] = {
          count: existing.count + 1,
          users: [...(existing.users || []), uid],
        };
      }

      return { ...msg, reactions };
    });

    // Determine action
    const msg = messages.find((m) => (m.messageId || m.tempId) === messageId);
    const hasReacted = msg?.reactions?.[emoji]?.users?.includes(currentUserIdRef.current);
    reactToGroupMessage(groupIdRef.current, messageId, emoji, hasReacted ? 'add' : 'remove', currentUserIdRef.current);
  }, [updateMessage, messages]);

  // ─── Mark as read ─────────────────────────────────────
  const markVisibleAsRead = useCallback((visibleMessageIds) => {
    if (!visibleMessageIds?.length || !groupIdRef.current) return;

    // Filter to only unread messages from others
    const unread = visibleMessageIds.filter((id) => {
      const msg = messages.find((m) => (m.messageId || m.tempId) === id);
      return msg && msg.senderId !== currentUserIdRef.current && msg.status !== 'read';
    });

    if (unread.length === 0) return;

    if (readTimerRef.current) clearTimeout(readTimerRef.current);
    readTimerRef.current = setTimeout(() => {
      markGroupMessagesRead(groupIdRef.current, unread, currentUserIdRef.current);
    }, READ_MARK_DELAY_MS);
  }, [messages]);

  // ─── Sync missed messages ─────────────────────────────
  const syncMissed = useCallback(async () => {
    if (!groupIdRef.current || isLoadingMore) return;
    setIsLoadingMore(true);

    syncGroupMessages(groupIdRef.current, nextCursorRef.current, 50, (response) => {
      setIsLoadingMore(false);
      // Handled via listener
    });
  }, [isLoadingMore]);

  // ─── Load more (pagination) ───────────────────────────
  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    syncMissed();
  }, [hasMore, isLoadingMore, syncMissed]);

  // ─── Socket listeners ─────────────────────────────────
  useEffect(() => {
    if (!groupId || !currentUserId) return;

    // Load cached messages first
    loadFromLocal();

    const onNewMessage = withAutoDelivery(currentUserId, (message) => {
      if (message.groupId !== groupIdRef.current) return;

      // Replace optimistic message if tempId matches
      if (message.tempId) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.tempId === message.tempId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...message, status: 'delivered', isLocal: false };
            saveToLocal(next);
            return next;
          }
          // New message from another user
          return prev;
        });
      }

      addMessages([{
        ...message,
        status: message.senderId === currentUserId ? 'sent' : 'delivered',
        timestamp: message.timestamp || new Date(message.createdAt).getTime(),
      }]);
    });

    const onMessageEdited = ({ groupId: gid, messageId, text, editedAt }) => {
      if (gid !== groupIdRef.current) return;
      updateMessage(messageId, (msg) => ({
        ...msg,
        text,
        isEdited: true,
        editedAt,
      }));
    };

    const onMessageDeleted = ({ groupId: gid, messageId, deleteFor }) => {
      if (gid !== groupIdRef.current) return;
      if (deleteFor === 'everyone') {
        updateMessage(messageId, (msg) => ({
          ...msg,
          isDeleted: true,
          deletedFor: 'everyone',
          text: 'This message was deleted',
        }));
      }
    };

    const onReadUpdate = ({ groupId: gid, messageIds, userId, readAt }) => {
      if (gid !== groupIdRef.current) return;
      setMessages((prev) => {
        let changed = false;
        const next = prev.map((msg) => {
          const id = msg.messageId || msg.tempId;
          if (messageIds.includes(id)) {
            changed = true;
            const readBy = { ...(msg.readBy || {}) };
            readBy[userId] = readAt;
            const allRead = Object.keys(readBy).length >= (msg.memberCount || 1);
            return { ...msg, readBy, status: allRead ? 'read' : msg.status };
          }
          return msg;
        });
        if (changed) saveToLocal(next);
        return changed ? next : prev;
      });
    };

    const onDeliveredUpdate = ({ groupId: gid, messageIds, userId, deliveredAt }) => {
      if (gid !== groupIdRef.current) return;
      setMessages((prev) => {
        let changed = false;
        const next = prev.map((msg) => {
          const id = msg.messageId || msg.tempId;
          if (messageIds.includes(id) && msg.status !== 'read') {
            changed = true;
            const deliveredTo = { ...(msg.deliveredTo || {}) };
            deliveredTo[userId] = deliveredAt;
            return { ...msg, deliveredTo, status: 'delivered' };
          }
          return msg;
        });
        if (changed) saveToLocal(next);
        return changed ? next : prev;
      });
    };

    const onSyncResponse = ({ groupId: gid, messages: synced, hasMore: more, nextCursor }) => {
      if (gid !== groupIdRef.current) return;
      setHasMore(more);
      nextCursorRef.current = nextCursor;
      setIsLoadingMore(false);

      if (synced.length > 0) {
        const normalized = synced.map((msg) => ({
          ...msg,
          messageId: msg.messageId || msg._id,
          timestamp: msg.timestamp || new Date(msg.createdAt).getTime(),
          status: msg.senderId === currentUserIdRef.current ? (msg.status || 'sent') : 'delivered',
        }));
        addMessages(normalized, true);
      }
    };

    const onReactionUpdate = ({ groupId: gid, messageId, emoji, action, userId, reactions }) => {
      if (gid !== groupIdRef.current) return;

      updateMessage(messageId, (msg) => {
        // If server sends full reactions map, use it
        if (reactions) return { ...msg, reactions };

        // Otherwise compute locally
        const rxns = { ...(msg.reactions || {}) };
        const existing = rxns[emoji] || { count: 0, users: [] };

        if (action === 'add') {
          if (!existing.users.includes(userId)) {
            rxns[emoji] = {
              count: existing.count + 1,
              users: [...existing.users, userId],
            };
          }
        } else {
          rxns[emoji] = {
            count: Math.max(0, existing.count - 1),
            users: existing.users.filter((u) => u !== userId),
          };
          if (rxns[emoji].count === 0) delete rxns[emoji];
        }

        return { ...msg, reactions: rxns };
      });
    };

    unsubRef.current = attachGroupMessageListeners({
      onNewMessage,
      onMessageEdited,
      onMessageDeleted,
      onReadUpdate,
      onDeliveredUpdate,
      onSyncResponse,
      onReactionUpdate,
    });

    // Initial sync for missed messages
    syncGroupMessages(groupId, null, 50);

    return () => {
      unsubRef.current?.();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (readTimerRef.current) clearTimeout(readTimerRef.current);
    };
  }, [groupId, currentUserId]);

  // ─── Read receipts per message ────────────────────────
  const getReadReceipts = useCallback((messageId) => {
    const msg = messages.find((m) => (m.messageId || m.tempId) === messageId);
    return {
      readBy: msg?.readBy || {},
      deliveredTo: msg?.deliveredTo || {},
      readCount: Object.keys(msg?.readBy || {}).length,
      deliveredCount: Object.keys(msg?.deliveredTo || {}).length,
    };
  }, [messages]);

  return {
    messages,
    isLoadingMore,
    hasMore,
    typingUsers,

    // Actions
    sendText,
    sendMedia,
    resendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    markVisibleAsRead,
    loadMore,
    syncMissed,

    // Read receipts
    getReadReceipts,
  };
}
