import { useMemo, useRef } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';
import { TYPING_TIMEOUT } from '../constants';

export default function useTypingIndicator(chatId, recipientId) {
  const { state, actions } = usePresenceStore();
  const typingTimeoutRef = useRef(null);
  const startedAtRef = useRef(null);

  const startTyping = async (messageType = null) => {
    if (!chatId || !recipientId) return;
    await socketService.emitTypingStart(chatId, recipientId, messageType);
    startedAtRef.current = Date.now();

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      stopTyping();
    }, TYPING_TIMEOUT);
  };

  const stopTyping = async () => {
    if (!chatId || !recipientId) return;
    await socketService.emitTypingStop(chatId, recipientId);
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  };

  const typingState = state.typingIndicators[chatId] || {};
  const typingEntries = Object.entries(typingState).filter(([, value]) => value?.isTyping);
  const [typingUser, typingData] = typingEntries[0] || [null, null];

  return useMemo(() => ({
    isTyping: Boolean(typingTimeoutRef.current),
    startTyping,
    stopTyping,
    isOtherTyping: typingEntries.length > 0,
    typingUser,
    typingMessageType: typingData?.messageType || null,
    typingStartedAt: typingData?.startedAt || startedAtRef.current,
  }), [typingEntries.length, typingUser, typingData]);
}
