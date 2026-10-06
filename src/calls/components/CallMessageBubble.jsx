import React, { useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../useCall';
import { resolveDisplayName as resolveCanonicalName } from '../../services/contactNameStore';
import { directionMeta, isConnectedOutcome } from '../callDirectionMeta';
import { resolveDirection, hasResolvableIdentity } from '../../utils/messageDirection';
import { healCallDetails } from '../services/inThreadCallService';

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
// WhatsApp wording: "1 sec", "55 secs", "1 min", "28 mins", "1 hr 5 mins".
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const fmtDuration = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  if (!s) return '';
  if (s < 60) return plural(s, 'sec');
  const m = Math.floor(s / 60);
  if (m < 60) return plural(m, 'min');
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${plural(h, 'hr')} ${plural(rm, 'min')}` : plural(h, 'hr');
};

export default function CallMessageBubble({
  msg, peer, chatId, timeText, isGroup = false, onCallBack: onCallBackProp = null,
  currentUserId = null,
}) {
  const { theme, isDarkMode, chatColor } = useTheme();
  const { startAudioCall, startVideoCall, callBusy } = useCall();

  const payload = msg?.payload || {};
  // Row saved without its call details (older ingest dropped `callDetails`):
  // backfill from the server once per chat — the bubble re-renders from SQLite.
  const missingDetails = !payload.outcome;
  useEffect(() => {
    if (missingDetails && chatId) healCallDetails(String(chatId));
  }, [missingDetails, chatId]);
  const media = payload.media === 'video' ? 'video' : 'audio';
  const outcome = payload.outcome || 'completed';
  // Direction is derived per-viewer from the row's participant ids against the
  // authenticated user — the SAME rule every other bubble uses, so a call log
  // lands on the same side as a message from the same person.
  //
  // `payload.direction` is only a fallback. It is written by whichever device
  // logged the call, which makes it viewer-relative: correct for the device
  // that wrote it, and wrong for any copy that reached this device another way
  // (a restore, a sync, a second device on the same account). The ids are not
  // viewer-relative, so they are checked first.
  const direction = hasResolvableIdentity(msg, currentUserId)
    ? resolveDirection(msg, currentUserId)
    : (payload.direction || resolveDirection(msg, currentUserId));
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

  const { color: arrowStateColor } = directionMeta(direction, outcome);

  // WhatsApp layout: title "Voice call" / "Video call", subtitle = duration
  // ("55 secs") or the state ("No answer", "Tap to call back"), time bottom-right.
  const groupKind = isVideo ? 'Group video call' : 'Group voice call';
  const title = isMissed
    ? `Missed ${kind} call`
    : (isGroup ? groupKind : (isVideo ? 'Video call' : 'Voice call'));
  let subtitle;
  if (connected) subtitle = fmtDuration(payload.durationSec) || (isOutgoing ? 'Outgoing' : 'Incoming');
  else if (isMissed) subtitle = 'Tap to call back';
  else if (outcome === 'rejected') subtitle = isOutgoing ? 'Declined' : 'You declined';
  else if (outcome === 'failed') subtitle = 'Not connected';
  else subtitle = 'No answer';

  // Bubble surfaces match the text bubbles: sent = the user's chat accent
  // (white content), received = theme.colors.bubbleReceived.
  const bubbleColor = isOutgoing
    ? ((chatColor && chatColor !== '#03b0a2') ? chatColor : '#03574f')
    : theme.colors.bubbleReceived;
  const onBubble = isOutgoing ? '#ffffff' : theme.colors.primaryTextColor;
  const onBubbleSoft = isOutgoing ? 'rgba(255,255,255,0.72)' : theme.colors.placeHolderTextColor;

  // Round chip with a directional phone glyph (↗ outgoing, ↙ incoming, missed
  // = red). Video keeps the camera glyph — there is no directional variant.
  const iconName = isVideo
    ? 'video'
    : (isMissed ? 'phone-missed' : (isOutgoing ? 'phone-outgoing' : 'phone-incoming'));
  const iconColor = isMissed
    ? arrowStateColor
    : (isOutgoing ? '#ffffff' : onBubble);
  const chipBg = isOutgoing
    ? 'rgba(0,0,0,0.18)'
    : (isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)');

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
        <View style={styles.body}>
          <View style={[styles.chip, { backgroundColor: chipBg }]}>
            <MaterialCommunityIcons name={iconName} size={17} color={iconColor} />
          </View>
          <View style={styles.textWrap}>
            <Text style={[styles.label, { color: onBubble }]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.sub, { color: onBubbleSoft }]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>
        {!!timeText && (
          <Text style={[styles.time, { color: onBubbleSoft }]} numberOfLines={1}>
            {timeText}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    width: '100%',
    paddingVertical: 2,
  },
  bubble: {
    paddingTop: 7,
    paddingBottom: 4,
    paddingLeft: 7,
    paddingRight: 9,
    borderRadius: 8,
    maxWidth: '78%',
    minWidth: 172,
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
  bubbleOut: { borderTopRightRadius: 3 },
  bubbleIn: { borderTopLeftRadius: 3 },
  body: { flexDirection: 'row', alignItems: 'center', paddingRight: 18 },
  chip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  textWrap: { flexShrink: 1 },
  label: { fontFamily: 'Roboto-Medium', fontSize: 14.5 },
  sub: { fontFamily: 'Roboto-Regular', fontSize: 12.5, marginTop: 1 },
  time: {
    alignSelf: 'flex-end',
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    marginTop: 1,
  },
});
