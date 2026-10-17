import React from 'react';
import { ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Delivery ticks, shared by the chat bubble footer, the media overlay and the
// chat-list row preview. STYLING ONLY: the glyph is chosen from the stored
// `status` exactly as before; colours come from the `tick` token set
// (theme.colors.tick, or the bubble-derived set from outgoingPaletteFor).
//
//   pending/scheduled  clock            neutral grey
//   sent               single check     neutral grey
//   delivered          double check     neutral grey
//   read/seen          double check     BLUE (tick.read)
//   failed             alert / refresh  danger red (tap = retry when onRetry)
//   cancelled          close-circle     danger red
//
// `variant="media"` uses the media* tokens (light-on-dark-scrim) for ticks
// painted over photos/videos.

export const TICK_LABELS = {
  scheduled: 'Scheduled',
  processing: 'Sending',
  pending: 'Waiting to send',
  sending: 'Sending',
  uploaded: 'Sent',
  sent: 'Sent',
  delivered: 'Delivered',
  seen: 'Read',
  read: 'Read',
  failed: 'Failed to send, double tap to retry',
  cancelled: 'Cancelled',
};

export const tickLabelFor = (status) => TICK_LABELS[status] || null;

export const TICK_SIZE = 14;
export const LIST_TICK_SIZE = 12;   // chat-list rows: a touch smaller than in a bubble

const MessageTicks = React.memo(function MessageTicks({
  status,
  colors,
  size = TICK_SIZE,
  variant = 'bubble',
  onRetry,
  style,
}) {
  const media = variant === 'media';
  // Media overlay: a cancelled upload is tappable (re-runs the send), like failed.
  const retryCancelled = media && status === 'cancelled' && !!onRetry;
  const label = retryCancelled ? 'Cancelled, double tap to retry' : tickLabelFor(status);
  if (!label || !colors) return null;
  const neutral = media ? colors.mediaNeutral : colors.sent;
  const readC = media ? colors.mediaRead : colors.read;
  const failC = media ? colors.mediaFailed : colors.failed;
  const base = { marginLeft: 2, ...(style || {}) };
  const a11y = { accessible: true, accessibilityRole: 'image', accessibilityLabel: label };
  const small = Math.max(12, size - 2);

  switch (retryCancelled ? 'failed' : status) {
    case 'scheduled':
    case 'processing':
    case 'pending':
      return <Ionicons {...a11y} name="time-outline" size={small} color={media ? neutral : colors.pending} style={base} />;
    case 'cancelled':
      return <Ionicons {...a11y} name="close-circle" size={small} color={failC} style={base} />;
    case 'sending':
      return (
        <ActivityIndicator
          {...a11y}
          size={Math.max(10, size - 5)}
          color={media ? neutral : colors.pending}
          style={base}
        />
      );
    case 'uploaded':
    case 'sent':
      return <Ionicons {...a11y} name="checkmark" size={size} color={neutral} style={base} />;
    case 'delivered':
      return <Ionicons {...a11y} name="checkmark-done" size={size} color={media ? neutral : colors.delivered} style={base} />;
    case 'seen':
    case 'read':
      return <Ionicons {...a11y} name="checkmark-done" size={size} color={readC} style={base} />;
    case 'failed': {
      const icon = (
        <Ionicons name={media ? 'refresh-circle' : 'alert-circle'} size={small} color={failC} style={base} />
      );
      if (!onRetry) {
        return <Ionicons {...a11y} name={media ? 'refresh-circle' : 'alert-circle'} size={small} color={failC} style={base} />;
      }
      return (
        <TouchableOpacity
          onPress={onRetry}
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          {icon}
        </TouchableOpacity>
      );
    }
    default:
      return null;
  }
});

// Chat-list / archived-list row tick. Maps the row's last-message status onto
// the same glyph+colour tokens as the thread (sending/pending/uploaded keep
// showing the single check, exactly as the list always did). Returns null for
// anything else, so a row without a status stays tick-free.
export const listTickStatus = (raw) => {
  const status = String(raw || '').toLowerCase();
  if (status === 'read' || status === 'seen') return 'read';
  if (status === 'delivered') return 'delivered';
  if (status === 'sent' || status === 'sending' || status === 'pending' || status === 'uploaded') return 'sent';
  if (status === 'failed') return 'failed';
  return null;
};

export const ChatListTick = ({ status, theme }) => {
  const st = listTickStatus(status);
  if (!st) return null;
  return (
    <MessageTicks
      status={st}
      colors={theme.colors.tick}
      size={LIST_TICK_SIZE}
      style={{ marginLeft: 0, marginRight: 4 }}
    />
  );
};

export default MessageTicks;
