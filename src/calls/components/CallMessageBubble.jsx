import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../useCall';
import { resolveDisplayName as resolveCanonicalName } from '../../services/contactNameStore';
import { directionMeta, isConnectedOutcome, CALL_RED_ON_ACCENT } from '../callDirectionMeta';

/**
 * In-thread "call" entry, WhatsApp style. Rendered by ChatScreen for messages of
 * type 'call'. Works in 1:1 AND group threads — a group bubble reads "Group
 * voice/video call" and dials through the `onCallBack` the screen supplies
 * (there is no single peer to ring). It is a SIDE-ALIGNED chat bubble — right for the outgoing leg
 * (sender), left for the incoming leg (receiver) — NOT centered. The whole
 * bubble taps to call the peer back. Render details ride in msg.payload.
 *
 * NOTE: standalone component (not inline in renderItem) so it may use hooks per
 * the app's FlatList rule. Cross-platform (Android + iOS) — StyleSheet only,
 * shadows via Platform.select.
 */
const fmtDuration = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  if (!s) return '';
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
};

export default function CallMessageBubble({
  msg, peer, chatId, timeText, isGroup = false, onCallBack: onCallBackProp = null,
}) {
  const { theme, isDarkMode, chatColor } = useTheme();
  const { startAudioCall, startVideoCall, callBusy } = useCall();

  const payload = msg?.payload || {};
  const media = payload.media === 'video' ? 'video' : 'audio';
  const outcome = payload.outcome || 'completed';
  // Direction is derived per-viewer: my own outgoing leg authored this message,
  // so senderType 'self' ⇒ outgoing. One canonical message reads correctly on
  // both ends without storing a viewer-relative direction.
  const direction = payload.direction || (msg?.senderType === 'self' ? 'outgoing' : 'incoming');
  const isVideo = media === 'video';
  const isOutgoing = direction === 'outgoing';
  const kind = isVideo ? 'video' : 'voice';
  const connected = isConnectedOutcome(outcome);
  // Red "Missed" FRAMING is narrower than "didn't connect": it belongs only to
  // the callee who never picked up. A call you declined yourself reads
  // neutrally as "Declined call", and the caller's own unanswered leg reads
  // neutrally too — matching the calls list, which reserves red text for a
  // genuinely missed incoming call. The ARROW is separate: it goes red for
  // every unconnected call on both sides.
  const isMissed = !isOutgoing && (outcome === 'missed' || outcome === 'cancelled');

  const peerMobile = peer?.mobileNumber
    || (peer?.mobile?.number ? `${peer.mobile.code || ''}${peer.mobile.number}` : null)
    || peer?.phone
    || null;
  const peerObj = peer ? {
    id: String(peer._id || peer.userId || peer.id || ''),
    // Call-back label follows the display rule, so an unsaved peer rings out as
    // a number rather than as the name they set on their own account.
    name: resolveCanonicalName({
      userId: peer._id || peer.userId || peer.id,
      phone: peerMobile,
      pushName: peer.fullName || peer.name,
      // Contact privacy — an outgoing call to a peer who hides their number
      // rings out under their handle.
      username: peer.userName || peer.publicUsername || null,
      hideContact: Boolean(peer.hideContact ?? peer.privacySettings?.hideContact),
      fallback: 'Unknown',
    }),
    pushName: peer.fullName || peer.name || null,
    mobile: peerMobile,
    avatar: peer.profileImage || peer.profilePicture || null,
  } : null;

  // Call back. A GROUP thread has no single peer to ring, and the roster lives
  // on the screen rendering this bubble — so the caller passes `onCallBack` and
  // this component stays dumb about how a group is dialled. 1:1 keeps its own
  // peer-based path.
  const onCallBack = useCallback(() => {
    if (onCallBackProp) { onCallBackProp(isVideo ? 'video' : 'audio'); return; }
    if (!peerObj?.id) return;
    if (isVideo) startVideoCall?.(peerObj, chatId);
    else startAudioCall?.(peerObj, chatId);
  }, [onCallBackProp, peerObj, isVideo, chatId, startAudioCall, startVideoCall]);
  // Nothing to dial (a group bubble with no roster yet) → don't offer the tap.
  const canCallBack = !!onCallBackProp || !!peerObj?.id;

  // Direction arrow: one shared convention with the calls list and the call
  // detail screen (green ↗/↙ when the call connected, red ↗/↙ when it did not),
  // so the same call never reads as two different states in two places.
  const { icon: arrowName, color: arrowStateColor } = directionMeta(direction, outcome);

  let label;
  const groupKind = isVideo ? 'Group video call' : 'Group voice call';
  if (outcome === 'completed') label = isGroup ? groupKind : (isVideo ? 'Video call' : 'Voice call');
  else if (outcome === 'rejected') label = isOutgoing ? 'Call declined' : 'Declined call';
  else if (isMissed) label = `Missed ${kind} call`;
  else if (outcome === 'cancelled') label = 'Cancelled call';
  else if (outcome === 'missed') label = 'No answer';
  else if (outcome === 'failed') label = 'Call not connected';
  else label = isGroup ? groupKind : (isVideo ? 'Video call' : 'Voice call');

  // WhatsApp bubble surfaces: sent = the user's chosen chat accent (white
  // content), received = card surface (themed text). Mirrors the audio/text
  // bubbles in ChatScreen so a custom Appearance accent applies here too —
  // when no custom accent is set, fall back to WhatsApp's outgoing green.
  // Received side reads the SAME token as every other incoming bubble
  // (theme.colors.bubbleReceived). It used to be cardBackground / '#ffffff',
  // which quietly drifted: once the received bubble was darkened for the
  // true-black chat ground, a call log sat in the thread as a paler slab than
  // the messages around it.
  const bubbleColor = isOutgoing
    ? ((chatColor && chatColor !== '#03b0a2') ? chatColor : '#03574f')
    : theme.colors.bubbleReceived;
  const onBubble = isOutgoing ? '#ffffff' : theme.colors.primaryTextColor;
  const onBubbleSoft = isOutgoing ? 'rgba(255,255,255,0.7)' : theme.colors.placeHolderTextColor;
  const labelColor = isMissed ? theme.colors.danger : onBubble;
  // The state color reads on the received surface as-is; on the outgoing bubble
  // it sits on dark green, so connected keeps the bubble's own white and the
  // unanswered red is lifted to stay legible.
  const arrowColor = isOutgoing
    ? (connected ? 'rgba(255,255,255,0.9)' : CALL_RED_ON_ACCENT)
    : arrowStateColor;

  // Round icon chip — tinted to the call state, like WhatsApp's call-log glyph:
  // themed for a connected call, red for one that never went through.
  const chipStateColor = isOutgoing
    ? '#ffffff'
    : (connected ? theme.colors.themeColor : arrowStateColor);
  const chipBg = isOutgoing ? 'rgba(255,255,255,0.18)' : (chipStateColor + '1F');
  const chipColor = chipStateColor;

  const durationText = outcome === 'completed' ? fmtDuration(payload.durationSec) : '';
  const metaText = [timeText, durationText].filter(Boolean).join('  ·  ');

  return (
    <View style={[styles.row, { justifyContent: isOutgoing ? 'flex-end' : 'flex-start' }]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onCallBack}
        disabled={callBusy || !canCallBack}
        style={[
          styles.bubble,
          isOutgoing ? styles.bubbleOut : styles.bubbleIn,
          {
            backgroundColor: bubbleColor,
            // Same hairline the text bubbles carry: in light mode the received
            // surface and the chat background are both #ffffff.
            borderWidth: (!isDarkMode && !isOutgoing) ? StyleSheet.hairlineWidth : 0,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <View style={[styles.chip, { backgroundColor: chipBg }]}>
          <Ionicons name={isVideo ? 'videocam' : 'call'} size={18} color={chipColor} />
        </View>

        <View style={styles.textWrap}>
          <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
            {label}
          </Text>
          <View style={styles.metaRow}>
            <MaterialIcons name={arrowName} size={14} color={arrowColor} style={styles.metaArrow} />
            <Text style={[styles.meta, { color: onBubbleSoft }]} numberOfLines={1}>
              {metaText}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    width: '100%',
    paddingVertical: 3,
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: 14,
    maxWidth: '78%',
    minWidth: 168,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.12,
        shadowRadius: 1.5,
      },
      android: { elevation: 1 },
    }),
  },
  // WhatsApp asymmetric "tail" corner.
  bubbleOut: { borderTopRightRadius: 4 },
  bubbleIn: { borderTopLeftRadius: 4 },
  chip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  textWrap: { flex: 1 },
  label: { fontFamily: 'Roboto-Medium', fontSize: 14.5 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  metaArrow: { marginRight: 4 },
  meta: { fontFamily: 'Roboto-Regular', fontSize: 11.5 },
});
