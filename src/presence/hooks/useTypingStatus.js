import { useMemo } from 'react';
import * as socketService from '../services/presenceSocket.service';
import { usePresenceStore } from '../store/PresenceContext';

export default function useTypingStatus(chatId) {
  const { state } = usePresenceStore();
  const typingMap = state.typingIndicators[chatId] || {};
  const typingUsers = Object.keys(typingMap).filter((userId) => typingMap[userId]?.isTyping);

  const refresh = async () => {
    if (!chatId) return null;
    return socketService.emitTypingStatus(chatId);
  };

  const typingSummary = useMemo(() => {
    if (!typingUsers.length) return '';
    if (typingUsers.length === 1) return `${typingUsers[0]} is typing`;
    return `${typingUsers[0]} and ${typingUsers.length - 1} others are typing`;
  }, [typingUsers]);

  return {
    typingUsers,
    typingSummary,
    refresh,
  };
}
