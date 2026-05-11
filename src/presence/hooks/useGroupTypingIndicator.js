import { useMemo } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';

const buildSummary = (users = []) => {
  if (users.length === 0) return '';
  if (users.length === 1) return `${users[0]} is typing`;
  if (users.length === 2) return `${users[0]}, ${users[1]} are typing`;
  return `${users[0]}, ${users[1]} and ${users.length - 2} others are typing`;
};

export default function useGroupTypingIndicator(groupId) {
  const { state, actions } = usePresenceStore();
  const entry = state.typingIndicators[groupId] || { typingUsers: [] };
  const typingUsers = entry.typingUsers || [];

  const startTyping = async (messageType = null) => {
    if (!groupId) return;
    await socketService.emitGroupTypingStart(groupId, messageType);
  };

  const stopTyping = async () => {
    if (!groupId) return;
    await socketService.emitGroupTypingStop(groupId);
  };

  const clearTyping = (userId) => {
    const nextUsers = typingUsers.filter((id) => id !== userId);
    actions.setGroupTyping(groupId, nextUsers);
  };

  return useMemo(() => ({
    startTyping,
    stopTyping,
    typingUsers: typingUsers.map((userId) => ({ userId, name: userId, messageType: null })),
    typingCount: typingUsers.length,
    typingSummary: buildSummary(typingUsers),
    isMultipleTyping: typingUsers.length > 1,
    clearTyping,
  }), [typingUsers, groupId]);
}