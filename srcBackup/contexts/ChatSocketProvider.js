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

      const localKey = `chat_messages_${chatId}`;

      try {
        const savedMessagesJSON = await AsyncStorage.getItem(localKey);
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

    if (socket && isSocketConnected()) {
      socket.on('message:new', handleNewMessage);
    }

    // Cleanup on unmount
    return () => {
      isMounted.current = false;
      if (socket) socket.off('message:new', handleNewMessage);
    };
  }, [onNewMessage]);

  return children;
}