import moment from 'moment';
import { STATUS_COLORS, STATUS_ICONS, STATUS_TYPES } from '../constants';

// Full-width phrasing for screens that have the room for it:
//   today            → "last seen today at 12:50 PM"
//   yesterday        → "last seen yesterday at 12:50 PM"
//   within this week → "last seen Monday at 12:50 PM"
//   this year        → "last seen 3 September at 12:50 PM"
//   older            → "last seen 3 September 2025 at 12:50 PM"
const formatLastSeenLongFrom = (m) => {
  const time = m.format('h:mm A');
  const now = moment();
  if (m.isSame(now, 'day')) return `last seen today at ${time}`;
  if (m.isSame(now.clone().subtract(1, 'day'), 'day')) return `last seen yesterday at ${time}`;
  // Strictly inside the last 7 days, so a weekday name is never ambiguous
  // between this week and last.
  if (m.isAfter(now.clone().subtract(7, 'day'))) return `last seen ${m.format('dddd')} at ${time}`;
  if (m.isSame(now, 'year')) return `last seen ${m.format('D MMMM')} at ${time}`;
  return `last seen ${m.format('D MMMM YYYY')} at ${time}`;
};

// Compact absolute time, never relative "a few minutes ago":
//   today            → "last seen 4:20 PM"
//   yesterday        → "last seen yesterday 4:20 PM"
//   within this week → "last seen Mon 4:20 PM"
//   older            → "last seen 18/07/26"
export const formatLastSeen = (timestamp, privacyLevel = 'everyone', options = {}) => {
  if (!timestamp) return 'offline';
  if (privacyLevel === 'nobody') return 'last seen recently';
  // Limited-visibility peers get the literal string 'recently' from the
  // backend instead of a timestamp.
  if (timestamp === 'recently') return 'last seen recently';
  // Numeric epochs arrive as numbers or numeric strings; anything else (an ISO
  // string like 2026-09-03T07:20:30.107Z) goes to moment as-is.
  const m = moment(Number(timestamp) || timestamp);
  if (!m.isValid()) return 'last seen recently';

  // Roomy screens (profile hero, details sheet) pass style:'long' for the full
  // WhatsApp phrasing — "last seen today at 12:50 PM" — which the narrow chat
  // header cannot fit. See the note below the compact branch.
  if (options.style === 'long') return formatLastSeenLongFrom(m);

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

// Convenience wrapper for profile / details surfaces.
export const formatLastSeenLong = (timestamp, privacyLevel = 'everyone') =>
  formatLastSeen(timestamp, privacyLevel, { style: 'long' });
