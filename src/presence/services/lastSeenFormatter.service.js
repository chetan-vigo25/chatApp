import moment from 'moment';
import { STATUS_COLORS, STATUS_ICONS, STATUS_TYPES } from '../constants';

export const formatLastSeen = (timestamp, privacyLevel = 'everyone') => {
  if (!timestamp) return 'offline';
  if (privacyLevel === 'nobody') return 'last seen recently';
  return `last seen ${moment(timestamp).fromNow()}`;
};

export const getStatusColor = (status) => {
  return STATUS_COLORS[status] || STATUS_COLORS.offline;
};

export const getStatusIcon = (status) => {
  return STATUS_ICONS[status] || STATUS_ICONS.offline;
};

export const getStatusPriority = (status) => {
  if (status === STATUS_TYPES.ONLINE) return 0;
  if (status === STATUS_TYPES.AWAY) return 1;
  if (status === STATUS_TYPES.BUSY) return 2;
  return 3;
};

export const isRecent = (timestamp, minutes = 5) => {
  if (!timestamp) return false;
  return Date.now() - Number(timestamp) <= minutes * 60 * 1000;
};

export const getRelativeTimeString = (timestamp) => {
  if (!timestamp) return '';
  return moment(timestamp).fromNow();
};

export const getLastSeenText = (presence) => {
  if (!presence) return 'offline';
  if (presence.status === STATUS_TYPES.ONLINE) return 'online';
  if (presence.customStatus) return presence.customStatus;
  return formatLastSeen(presence.lastSeen);
};