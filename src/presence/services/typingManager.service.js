import { TYPING_TIMEOUT } from '../constants';

const typingTimeouts = new Map();
const groupTypingMap = new Map();

const timeoutKey = (chatId, userId) => `${chatId}:${userId}`;

export const setTypingTimeout = (chatId, userId, duration = TYPING_TIMEOUT, onExpire) => {
  const key = timeoutKey(chatId, userId);
  clearTypingTimeout(chatId, userId);

  const timeoutId = setTimeout(() => {
    typingTimeouts.delete(key);
    if (typeof onExpire === 'function') {
      onExpire();
    }
  }, duration);

  typingTimeouts.set(key, timeoutId);
  return key;
};

export const clearTypingTimeout = (chatId, userId) => {
  const key = timeoutKey(chatId, userId);
  const timeoutId = typingTimeouts.get(key);
  if (timeoutId) {
    clearTimeout(timeoutId);
    typingTimeouts.delete(key);
  }
};

export const getTypingStatus = (chatId) => {
  const users = [];
  typingTimeouts.forEach((_, key) => {
    if (key.startsWith(`${chatId}:`)) {
      users.push(key.split(':')[1]);
    }
  });
  return users;
};

export const setGroupTyping = (groupId, userId) => {
  const current = groupTypingMap.get(groupId) || new Set();
  current.add(userId);
  groupTypingMap.set(groupId, current);
};

export const clearGroupTyping = (groupId, userId) => {
  const current = groupTypingMap.get(groupId);
  if (!current) return;
  current.delete(userId);
  groupTypingMap.set(groupId, current);
};

export const getGroupTypingUsers = (groupId) => {
  return Array.from(groupTypingMap.get(groupId) || []);
};

export const formatTypingSummary = (groupId, usersMap = {}) => {
  const users = getGroupTypingUsers(groupId).map((userId) => usersMap[userId] || userId);
  if (users.length === 0) return '';
  if (users.length === 1) return `${users[0]} is typing`;
  if (users.length === 2) return `${users[0]} and ${users[1]} are typing`;
  if (users.length === 3) return `${users[0]}, ${users[1]} and ${users[2]} are typing`;
  return `${users[0]}, ${users[1]} and ${users.length - 2} others are typing`;
};

export const cleanupStaleTyping = () => {
  // Timeouts auto-clean themselves; this is a no-op but kept for API compatibility.
};