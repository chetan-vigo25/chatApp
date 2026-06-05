import React, { useCallback } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../useCall';

/**
 * Audio + video call buttons for the 1:1 chat header. Wire into
 * ChatHeaderPresence's `rightActions`. `peer` is the chat's peerUser; `chatId`
 * is the canonical chat id so the in-thread call entry lands in this thread.
 */
export default function CallButtons({ peer, chatId }) {
  const { theme } = useTheme();
  const { startAudioCall, startVideoCall } = useCall();

  const peerObj = peer ? {
    id: String(peer._id || peer.userId || peer.id || ''),
    name: peer.fullName || peer.name || 'Unknown',
    avatar: peer.profileImage || peer.profilePicture || null,
  } : null;

  const onAudio = useCallback(() => {
    if (peerObj?.id && startAudioCall) startAudioCall(peerObj, chatId);
  }, [peerObj, chatId, startAudioCall]);

  const onVideo = useCallback(() => {
    if (peerObj?.id && startVideoCall) startVideoCall(peerObj, chatId);
  }, [peerObj, chatId, startVideoCall]);

  if (!peerObj?.id) return null;
  const color = theme.colors.primaryTextColor;

  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={onVideo} activeOpacity={0.7} style={styles.btn} hitSlop={styles.hit}>
        <Ionicons name="videocam-outline" size={23} color={color} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onAudio} activeOpacity={0.7} style={styles.btn} hitSlop={styles.hit}>
        <Ionicons name="call-outline" size={21} color={color} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  btn: { paddingHorizontal: 9, paddingVertical: 6 },
  hit: { top: 8, bottom: 8, left: 8, right: 8 },
});
