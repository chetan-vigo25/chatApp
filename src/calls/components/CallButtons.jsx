import React, { useCallback } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../useCall';

/**
 * Audio + video call buttons for the 1:1 chat header. Wire into
 * ChatHeaderPresence's `rightActions`. `peer` is the chat's peerUser; `chatId`
 * is the canonical chat id so the in-thread call entry lands in this thread.
 */
export default function CallButtons({ peer, chatId }) {
  const { theme } = useTheme();
  const { startAudioCall, startVideoCall, callBusy } = useCall();

  const peerObj = peer ? {
    id: String(peer._id || peer.userId || peer.id || ''),
    name: peer.fullName || peer.name || 'Unknown',
    avatar: peer.profileImage || peer.profilePicture || null,
  } : null;
  const peerId = peerObj?.id || '';

  // Contact-block: dim + disable both call buttons when either side blocked the
  // other (I blocked them, or they blocked me) — same source the composer guard
  // uses. The CallProvider startCall gate enforces this too; this is the UI half.
  const isBlocked = useSelector((s) => {
    if (!peerId) return false;
    const iBlocked = (s?.block?.blockedIds || []).map(String).includes(peerId);
    const blockedMe = (s?.block?.blockedByIds || []).map(String).includes(peerId);
    return iBlocked || blockedMe;
  });

  const onAudio = useCallback(() => {
    if (peerObj?.id && startAudioCall) startAudioCall(peerObj, chatId);
  }, [peerObj, chatId, startAudioCall]);

  const onVideo = useCallback(() => {
    if (peerObj?.id && startVideoCall) startVideoCall(peerObj, chatId);
  }, [peerObj, chatId, startVideoCall]);

  if (!peerObj?.id) return null;
  // Dim + disable both buttons while another call is in progress (so a second
  // call can't start over a live/ringing one) or when blocked either direction.
  const disabled = callBusy || isBlocked;
  const color = disabled ? theme.colors.secondaryTextColor : theme.colors.primaryTextColor;

  return (
    <View style={styles.row}>
      <TouchableOpacity
        onPress={onVideo}
        disabled={disabled}
        activeOpacity={0.7}
        style={[styles.btn, disabled && styles.disabled]}
        hitSlop={styles.hit}
      >
        <Ionicons name="videocam-outline" size={23} color={color} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onAudio}
        disabled={disabled}
        activeOpacity={0.7}
        style={[styles.btn, disabled && styles.disabled]}
        hitSlop={styles.hit}
      >
        <Ionicons name="call-outline" size={21} color={color} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  btn: { paddingHorizontal: 9, paddingVertical: 6 },
  disabled: { opacity: 0.4 },
  hit: { top: 8, bottom: 8, left: 8, right: 8 },
});
