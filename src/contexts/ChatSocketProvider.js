import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';
import moment from 'moment';
import {
  clearChatLocalArtifacts,
  getChatMessagesKey,
  isMessageBeforeChatClear,
} from '../utils/chatClearStorage';

// Track messageIds already acknowledged as delivered to avoid duplicate emits
const deliveredAckSet = new Set();
const MAX_DELIVERED_ACK_SIZE = 500;

const emitDelivered = (socket, { messageId, chatId, senderId }) => {
  if (!socket || !messageId || !chatId || !senderId) return;
  if (deliveredAckSet.has(messageId)) return;

  deliveredAckSet.add(messageId);
  // Prevent unbounded growth
  if (deliveredAckSet.size > MAX_DELIVERED_ACK_SIZE) {
    const first = deliveredAckSet.values().next().value;
    deliveredAckSet.delete(first);
  }

  socket.emit('message:delivered', { messageId, chatId, senderId });
};

const deduplicateMessages = (messagesArray) => {
  if (!Array.isArray(messagesArray)) return [];
  
  const uniqueMap = new Map();
  messagesArray.forEach((msg) => {
    if (!msg) return;

    const key = msg.serverMessageId || msg.id || msg.tempId || `${msg.senderId}_${msg.timestamp}`;
    if (!key) return;

    const existing = uniqueMap.get(key);
    if (!existing || (msg.timestamp > (existing.timestamp || 0))) {
      uniqueMap.set(key, msg);
    }
  });

  // Sort by timestamp ascending
  return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
};

const markDeletedForEveryone = (messages = [], messageId, deletedBy = null) => {
  if (!Array.isArray(messages) || !messageId) {
    return { updated: false, nextMessages: Array.isArray(messages) ? messages : [] };
  }

  let found = false;
  const normalizedMessageId = String(messageId);

  const nextMessages = messages.map((msg) => {
    const candidates = [msg?.serverMessageId, msg?.id, msg?.tempId].filter(Boolean).map(String);
    const isMatch = candidates.includes(normalizedMessageId);

    if (!isMatch) return msg;

    found = true;
    return {
      ...msg,
      type: 'system',
      text: 'This message was deleted',
      isDeleted: true,
      deletedFor: 'everyone',
      deletedBy: deletedBy ? String(deletedBy) : null,
      mediaUrl: null,
      previewUrl: null,
      localUri: null,
    };
  });

  return { updated: found, nextMessages };
};

export default function ChatSocketProvider({ children, onNewMessage }) {
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;

    const socket = getSocket();

    const handleNewMessage = async (data) => {
      if (!data) return;

      const chatId = data.chatId || data.roomId;
      if (!chatId) return;

      const messageId = data.messageId || data._id;
      const createdAt = data.createdAt || new Date();
      const timestamp = new Date(createdAt).getTime();

      if (await isMessageBeforeChatClear(chatId, timestamp)) {
        return;
      }

      const msg = {
        id: messageId,
        serverMessageId: messageId,
        tempId: messageId,
        type: data.messageType || data.fileCategory || 'text',
        mediaType: data.fileCategory || null,
        text: data.text || data.content || '',
        time: moment(createdAt).format('hh:mm A'),
        date: moment(createdAt).format('YYYY-MM-DD'),
        senderId: data.senderId,
        receiverId: data.receiverId,
        status: undefined,
        mediaUrl: data.mediaUrl || data.url || null,
        previewUrl: data.previewUrl || data.thumbnailUrl || data.mediaUrl || data.url || null,
        createdAt: new Date(createdAt).toISOString(),
        timestamp,
        synced: true,
        localUri: null,
        chatId,
        mediaMeta: data.mediaMeta || data.contact || data.payload?.mediaMeta || data.payload?.contact || null,
        payload: data.payload || (data.contact ? { contact: data.contact } : null),
      };
      console.log("msg", msg)

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const savedMessagesJSON = await AsyncStorage.getItem(localKey);
        console.log("get localstorege chats --- ", savedMessagesJSON)
        let messages = [];
        if (savedMessagesJSON) {
          try {
            messages = JSON.parse(savedMessagesJSON);
          } catch {
            messages = [];
          }
        }

        const newMessages = deduplicateMessages([msg, ...messages]);
        await AsyncStorage.setItem(localKey, JSON.stringify(newMessages));

        if (typeof onNewMessage === 'function') {
          onNewMessage(msg, newMessages); // optional callback
        }

        // Emit message:delivered to server for incoming messages
        const currentUserRaw = await AsyncStorage.getItem('userInfo');
        const currentUser = currentUserRaw ? JSON.parse(currentUserRaw) : null;
        const currentUserId = currentUser?._id || currentUser?.id;
        if (currentUserId && data.senderId && data.senderId !== currentUserId) {
          emitDelivered(socket, {
            messageId: messageId,
            chatId: chatId,
            senderId: data.senderId,
          });
        }
      } catch (err) {
        console.error('ChatSocketProvider: failed to store message', err);
      }
    };

    const handleDeleteEveryoneResponse = async (payload, eventName = 'message:delete:everyone:response') => {
      console.log('🧪 [B:SOCKET:DELETE:RECV]', {
        event: eventName,
        raw: payload,
      });

      const source = payload?.data || payload || {};

      if (source?.status === false || source?.success === false) {
        return;
      }

      const chatId = source?.chatId || source?.chat || source?.roomId;
      const messageId = source?.messageId || source?._id || source?.id;
      const isDeleteForEveryone = (
        source?.deleteForEveryone === true ||
        source?.deleted === true ||
        source?.deleteFor === 'everyone' ||
        source?.delete_type === 'everyone'
      );

      if (!chatId || !messageId || !isDeleteForEveryone) {
        console.warn('ChatSocketProvider: invalid delete payload', source);
        return;
      }

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const savedMessagesJSON = await AsyncStorage.getItem(localKey);
        if (!savedMessagesJSON) return;

        let messages = [];
        try {
          messages = JSON.parse(savedMessagesJSON);
        } catch {
          messages = [];
        }

        if (!Array.isArray(messages) || messages.length === 0) {
          return;
        }

        console.log('🧪 [B:LOCAL:BEFORE]', {
          chatId,
          messageId,
          count: messages.length,
          matched: messages.some((m) =>
            String(m?.id) === String(messageId) ||
            String(m?.serverMessageId) === String(messageId) ||
            String(m?.tempId) === String(messageId)
          ),
        });

        const { updated, nextMessages } = markDeletedForEveryone(
          messages,
          messageId,
          source?.deletedBy || source?.senderId || source?.userId || null
        );

        if (!updated) {
          console.warn('ChatSocketProvider: message not found for delete', { chatId, messageId });
          return;
        }

        const finalMessages = deduplicateMessages(nextMessages);
        await AsyncStorage.setItem(localKey, JSON.stringify(finalMessages));

        console.log('🧪 [B:LOCAL:AFTER]', {
          chatId,
          messageId,
          updated,
          count: finalMessages.length,
        });
      } catch (err) {
        console.error('ChatSocketProvider: failed to apply delete to local storage', err);
      }
    };

    const onDeleteEveryoneResponse = (payload) => handleDeleteEveryoneResponse(payload, 'message:delete:everyone:response');
    const onDeleteResponse = (payload) => handleDeleteEveryoneResponse(payload, 'message:delete:response');
    const onDeleteEveryone = (payload) => handleDeleteEveryoneResponse(payload, 'message:delete:everyone');
    const onChatCleared = async (payload) => {
      const source = payload?.data || payload || {};
      const targetChatId = source?.chatId || source?.chat || source?.roomId;
      if (!targetChatId) return;
      try {
        await clearChatLocalArtifacts(targetChatId, { markCleared: true });
      } catch (err) {
        console.error('ChatSocketProvider: failed to clear local chat artifacts', err);
      }
    };

    // Handle message:delivered:response — update local message status
    const onDeliveredResponse = async (payload) => {
      const source = payload?.data || payload || {};
      const messageId = source?.messageId;
      const chatId = source?.chatId;
      if (!messageId || !chatId) return;

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const raw = await AsyncStorage.getItem(localKey);
        if (!raw) return;
        const messages = JSON.parse(raw);
        if (!Array.isArray(messages)) return;

        let changed = false;
        const updated = messages.map((msg) => {
          const id = msg?.serverMessageId || msg?.id || msg?.tempId;
          if (String(id) !== String(messageId)) return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg; // don't downgrade
          changed = true;
          return { ...msg, status: 'delivered' };
        });

        if (changed) {
          await AsyncStorage.setItem(localKey, JSON.stringify(updated));
        }
      } catch (err) {
        console.error('ChatSocketProvider: delivered response update failed', err);
      }
    };

    // Handle message:seen:response — update local message status
    const onSeenResponse = async (payload) => {
      const source = payload?.data || payload || {};
      const messageId = source?.messageId;
      const chatId = source?.chatId;
      if (!messageId || !chatId) return;

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const raw = await AsyncStorage.getItem(localKey);
        if (!raw) return;
        const messages = JSON.parse(raw);
        if (!Array.isArray(messages)) return;

        let changed = false;
        const updated = messages.map((msg) => {
          const id = msg?.serverMessageId || msg?.id || msg?.tempId;
          if (String(id) !== String(messageId)) return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });

        if (changed) {
          await AsyncStorage.setItem(localKey, JSON.stringify(updated));
        }
      } catch (err) {
        console.error('ChatSocketProvider: seen response update failed', err);
      }
    };

    // Handle message:read:all:response — mark all messages as read in local storage
    const onReadAllResponse = async (payload) => {
      const source = payload?.data || payload || {};
      const chatId = source?.chatId;
      if (!chatId) return;

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const raw = await AsyncStorage.getItem(localKey);
        if (!raw) return;
        const messages = JSON.parse(raw);
        if (!Array.isArray(messages)) return;

        const currentUserRaw = await AsyncStorage.getItem('userInfo');
        const currentUser = currentUserRaw ? JSON.parse(currentUserRaw) : null;
        const currentUserId = currentUser?._id || currentUser?.id;

        let changed = false;
        const updated = messages.map((msg) => {
          // Only mark own messages as read (peer read our messages)
          if (msg.senderId === currentUserId && msg.status !== 'seen') {
            changed = true;
            return { ...msg, status: 'seen' };
          }
          return msg;
        });

        if (changed) {
          await AsyncStorage.setItem(localKey, JSON.stringify(updated));
        }
      } catch (err) {
        console.error('ChatSocketProvider: read:all response update failed', err);
      }
    };

    // Handle message:read:bulk:response — mark batch of messages as read
    const onReadBulkResponse = async (payload) => {
      const source = payload?.data || payload || {};
      const chatId = source?.chatId;
      const results = Array.isArray(source?.results) ? source.results : [];
      if (!chatId || results.length === 0) return;

      const successIds = results.filter(r => r?.success).map(r => String(r?.messageId)).filter(Boolean);
      if (successIds.length === 0) return;

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const raw = await AsyncStorage.getItem(localKey);
        if (!raw) return;
        const messages = JSON.parse(raw);
        if (!Array.isArray(messages)) return;

        const idSet = new Set(successIds);
        let changed = false;
        const updated = messages.map((msg) => {
          const id = String(msg?.serverMessageId || msg?.id || msg?.tempId || '');
          if (!idSet.has(id)) return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });

        if (changed) {
          await AsyncStorage.setItem(localKey, JSON.stringify(updated));
        }
      } catch (err) {
        console.error('ChatSocketProvider: read:bulk response update failed', err);
      }
    };

    // Handle chat:list:update for message edits (receiver side)
    const onChatListUpdateForEdit = async (payload) => {
      const source = payload?.data || payload || {};
      const reason = (source?.reason || '').toString().toLowerCase();
      const type = (source?.type || '').toString().toLowerCase();
      const isEditEvent = reason === 'message.edited' || reason === 'kafka.message.edited' || type === 'message_edited';
      if (!isEditEvent) return;

      const item = source?.item || {};
      const chatId = source?.chatId || item?.chatId || item?._id;
      const messageId = item?.messageId || item?.lastMessage?.messageId || item?.lastMessage?.serverMessageId || item?.lastMessage?._id;
      const newText = item?.lastMessage?.text || (typeof item?.lastMessage === 'string' ? item.lastMessage : null) || item?.text;
      if (!messageId || !chatId || !newText) return;

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const raw = await AsyncStorage.getItem(localKey);
        if (!raw) return;
        const messages = JSON.parse(raw);
        if (!Array.isArray(messages)) return;

        let changed = false;
        const updated = messages.map((msg) => {
          const id = msg?.serverMessageId || msg?.id || msg?.tempId;
          if (String(id) !== String(messageId)) return msg;
          changed = true;
          return { ...msg, text: newText, isEdited: true, editedAt: item?.editedAt || item?.lastMessage?.editedAt || Date.now() };
        });

        if (changed) {
          await AsyncStorage.setItem(localKey, JSON.stringify(updated));
        }
      } catch (err) {
        console.error('ChatSocketProvider: chat:list:update edit failed', err);
      }
    };

    // Handle message:edit:response — update edited message in local storage
    const onEditResponse = async (payload) => {
      const source = payload?.data || payload || {};
      if (source?.status === false || payload?.status === false) return;

      const messageId = source?.messageId || source?.id;
      const chatId = source?.chatId;
      const newText = source?.text || source?.newText;
      if (!messageId || !chatId) return;

      const localKey = getChatMessagesKey(chatId);
      if (!localKey) return;

      try {
        const raw = await AsyncStorage.getItem(localKey);
        if (!raw) return;
        const messages = JSON.parse(raw);
        if (!Array.isArray(messages)) return;

        let changed = false;
        const updated = messages.map((msg) => {
          const id = msg?.serverMessageId || msg?.id || msg?.tempId;
          if (String(id) !== String(messageId)) return msg;
          changed = true;
          return {
            ...msg,
            text: newText || msg.text,
            isEdited: true,
            editedAt: source?.editedAt || Date.now(),
          };
        });

        if (changed) {
          await AsyncStorage.setItem(localKey, JSON.stringify(updated));
        }
      } catch (err) {
        console.error('ChatSocketProvider: edit response update failed', err);
      }
    };

    const attachMessageListeners = () => {
      if (!socket) return;
      socket.off('message:new', handleNewMessage);
      socket.off('message:delete:everyone:response', onDeleteEveryoneResponse);
      socket.off('message:delete:response', onDeleteResponse);
      socket.off('message:delete:everyone', onDeleteEveryone);
      socket.off('chat:cleared:me', onChatCleared);
      socket.off('chat:cleared:everyone', onChatCleared);
      socket.off('message:delivered:response', onDeliveredResponse);
      socket.off('message:seen:response', onSeenResponse);
      socket.off('message:read:all:response', onReadAllResponse);
      socket.off('message:read:bulk:response', onReadBulkResponse);
      socket.off('message:edit:response', onEditResponse);
      socket.off('message:edited', onEditResponse);
      socket.off('chat:list:update', onChatListUpdateForEdit);

      socket.on('message:new', handleNewMessage);
      socket.on('message:delete:everyone:response', onDeleteEveryoneResponse);
      socket.on('message:delete:response', onDeleteResponse);
      socket.on('message:delete:everyone', onDeleteEveryone);
      socket.on('chat:cleared:me', onChatCleared);
      socket.on('chat:cleared:everyone', onChatCleared);
      socket.on('message:delivered:response', onDeliveredResponse);
      socket.on('message:seen:response', onSeenResponse);
      socket.on('message:read:all:response', onReadAllResponse);
      socket.on('message:read:bulk:response', onReadBulkResponse);
      socket.on('message:edit:response', onEditResponse);
      socket.on('message:edited', onEditResponse);
      socket.on('chat:list:update', onChatListUpdateForEdit);
    };

    const detachMessageListeners = () => {
      if (!socket) return;
      socket.off('message:new', handleNewMessage);
      socket.off('message:delete:everyone:response', onDeleteEveryoneResponse);
      socket.off('message:delete:response', onDeleteResponse);
      socket.off('message:delete:everyone', onDeleteEveryone);
      socket.off('chat:cleared:me', onChatCleared);
      socket.off('chat:cleared:everyone', onChatCleared);
      socket.off('message:delivered:response', onDeliveredResponse);
      socket.off('message:seen:response', onSeenResponse);
      socket.off('message:read:all:response', onReadAllResponse);
      socket.off('message:read:bulk:response', onReadBulkResponse);
      socket.off('message:edit:response', onEditResponse);
      socket.off('message:edited', onEditResponse);
      socket.off('chat:list:update', onChatListUpdateForEdit);
    };

    const onSocketConnect = () => attachMessageListeners();
    const onSocketDisconnect = () => detachMessageListeners();

    if (socket) {
      if (isSocketConnected()) {
        attachMessageListeners();
      }
      socket.on('connect', onSocketConnect);
      socket.on('disconnect', onSocketDisconnect);
    }

    // Cleanup on unmount
    return () => {
      isMounted.current = false;
      if (socket) socket.off('connect', onSocketConnect);
      if (socket) socket.off('disconnect', onSocketDisconnect);
      detachMessageListeners();
    };
  }, [onNewMessage]);

  return children;
}