import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';
import moment from 'moment';

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
      };
      console.log("msg", msg)

      const localKey = `chat_messages_${chatId}`;

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

      const localKey = `chat_messages_${chatId}`;

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

    if (socket && isSocketConnected()) {
      socket.on('message:new', handleNewMessage);
      socket.on('message:delete:everyone:response', onDeleteEveryoneResponse);
      socket.on('message:delete:response', onDeleteResponse);
      socket.on('message:delete:everyone', onDeleteEveryone);
    }

    // Cleanup on unmount
    return () => {
      isMounted.current = false;
      if (socket) socket.off('message:new', handleNewMessage);
      if (socket) socket.off('message:delete:everyone:response', onDeleteEveryoneResponse);
      if (socket) socket.off('message:delete:response', onDeleteResponse);
      if (socket) socket.off('message:delete:everyone', onDeleteEveryone);
    };
  }, [onNewMessage]);

  return children;
}