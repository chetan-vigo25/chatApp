import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../useCall';

/**
 * In-thread "call" entry, WhatsApp style. Rendered by ChatScreen for messages of
 * type 'call'. It is a SIDE-ALIGNED chat bubble — right for the outgoing leg
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

export default function CallMessageBubble({ msg, peer, chatId, timeText }) {
  const { theme, isDarkMode, chatColor } = useTheme();
  const { startAudioCall, startVideoCall } = useCall();

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
  // "Missed" framing (red) only applies to the party who didn't answer — the
  // callee. The caller's own unanswered/cancelled leg reads neutrally.
  const isMissed = (outcome === 'missed' || outcome === 'cancelled') && !isOutgoing;

  const peerObj = peer ? {
    id: String(peer._id || peer.userId || peer.id || ''),
    name: peer.fullName || peer.name || 'Unknown',
    avatar: peer.profileImage || peer.profilePicture || null,
  } : null;

  const onCallBack = useCallback(() => {
    if (!peerObj?.id) return;
    if (isVideo) startVideoCall?.(peerObj, chatId);
    else startAudioCall?.(peerObj, chatId);
  }, [peerObj, isVideo, chatId, startAudioCall, startVideoCall]);

  // Direction arrow: green for connected, red for a missed/unanswered call.
  const arrowName = isMissed ? 'call-missed' : (isOutgoing ? 'call-made' : 'call-received');

  let label;
  if (outcome === 'completed') label = isVideo ? 'Video call' : 'Voice call';
  else if (outcome === 'rejected') label = isOutgoing ? 'Call declined' : 'Declined call';
  else if (isMissed) label = `Missed ${kind} call`;
  else if (outcome === 'cancelled' && isOutgoing) label = 'Cancelled call';
  else label = isVideo ? 'Video call' : 'Voice call';

  // WhatsApp bubble surfaces: sent = the user's chosen chat accent (white
  // content), received = card surface (themed text). Mirrors the audio/text
  // bubbles in ChatScreen so a custom Appearance accent applies here too —
  // when no custom accent is set, fall back to WhatsApp's outgoing green.
  const bubbleColor = isOutgoing
    ? ((chatColor && chatColor !== '#03b0a2') ? chatColor : '#03574f')
    : (isDarkMode ? theme.colors.cardBackground : '#ffffff');
  const onBubble = isOutgoing ? '#ffffff' : theme.colors.primaryTextColor;
  const onBubbleSoft = isOutgoing ? 'rgba(255,255,255,0.7)' : theme.colors.placeHolderTextColor;
  const missedColor = isOutgoing ? '#ffffff' : theme.colors.danger;
  const labelColor = isMissed ? missedColor : onBubble;
  const arrowColor = isMissed
    ? missedColor
    : (isOutgoing ? 'rgba(255,255,255,0.9)' : '#1DAB61');

  // Round icon chip — tinted to the call media, like WhatsApp's call-log glyph.
  const chipBg = isOutgoing ? 'rgba(255,255,255,0.18)' : (theme.colors.themeColor + '1F');
  const chipColor = isOutgoing ? '#ffffff' : theme.colors.themeColor;

  const durationText = outcome === 'completed' ? fmtDuration(payload.durationSec) : '';
  const metaText = [timeText, durationText].filter(Boolean).join('  ·  ');

  return (
    <View style={[styles.row, { justifyContent: isOutgoing ? 'flex-end' : 'flex-start' }]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onCallBack}
        style={[
          styles.bubble,
          isOutgoing ? styles.bubbleOut : styles.bubbleIn,
          { backgroundColor: bubbleColor },
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
            <MaterialCommunityIcons name={arrowName} size={13} color={arrowColor} style={styles.metaArrow} />
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
