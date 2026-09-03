import moment from 'moment';
import { STATUS_COLORS, STATUS_ICONS, STATUS_TYPES } from '../constants';

// Compact absolute time, never relative "a few minutes ago":
//   today            → "last seen 4:20 PM"
//   yesterday        → "last seen yesterday 4:20 PM"
//   within this week → "last seen Mon 4:20 PM"
//   older            → "last seen 18/07/26"
export const formatLastSeen = (timestamp, privacyLevel = 'everyone') => {
  if (!timestamp) return 'offline';
  if (privacyLevel === 'nobody') return 'last seen recently';
  // Limited-visibility peers get the literal string 'recently' from the
  // backend instead of a timestamp.
  if (timestamp === 'recently') return 'last seen recently';
  const m = moment(Number(timestamp) || timestamp);
  if (!m.isValid()) return 'last seen recently';

  const time = m.format('h:mm A');
  const now = moment();
  // Compact on purpose — this is the form the header block is sized for. The
  // long variants ("last seen today at 3:41 PM") overflowed the chat header's
  // narrow text column between the avatar and the call/menu buttons, so the
  // one thing the line exists to say — the TIME — was the part that got cut
  // off ("last seen today at 3:…"). Dropping the filler words ("today at")
  // costs no information: a bare time already means today.
  if (m.isSame(now, 'day')) return `last seen ${time}`;
  if (m.isSame(now.clone().subtract(1, 'day'), 'day')) return `last seen yesterday ${time}`;
  if (m.isAfter(now.clone().subtract(7, 'day'))) return `last seen ${m.format('ddd')} ${time}`;
  return `last seen ${m.format('DD/MM/YY')}`;
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