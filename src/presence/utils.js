import { STATUS_TYPES } from './constants';
import { formatLastSeen, getStatusColor, getStatusIcon, getStatusPriority } from './services/lastSeenFormatter.service';

export const isValidStatus = (status) => Object.values(STATUS_TYPES).includes(status);
export const isValidCustomStatus = (status, maxLength = 100) => typeof status === 'string' && status.length <= maxLength;
export const isValidExpiry = (expiresAt) => {
  if (!expiresAt) return true;
  const date = new Date(expiresAt);
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
};
export const isValidUserIds = (userIds = [], maxSize = 200) => Array.isArray(userIds) && userIds.length <= maxSize && userIds.every(Boolean);

export const formatGroupTypingSummary = (users = [], limit = 3) => {
  if (!users.length) return '';
  const names = users.slice(0, limit);
  if (users.length === 1) return `${names[0]} is typing`;
  if (users.length <= limit) return `${names.join(', ')} are typing`;
  return `${names.join(', ')} and ${users.length - limit} others are typing`;
};

export const getEffectiveStatus = (presence = {}) => {
  if (presence.isInvisible) return STATUS_TYPES.OFFLINE;
  if (presence.manualOverride && presence.manualStatus) return presence.manualStatus;
  return presence.status || STATUS_TYPES.OFFLINE;
};

export const isRecentlyOnline = (lastSeen, threshold = 5) => {
  if (!lastSeen) return false;
  return Date.now() - Number(lastSeen) <= threshold * 60 * 1000;
};

export { formatLastSeen, getStatusColor, getStatusIcon, getStatusPriority };
