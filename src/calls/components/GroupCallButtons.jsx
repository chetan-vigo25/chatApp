import React, { useCallback } from 'react';
import { View, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../useCall';

/**
 * Audio + video group-call buttons for a GROUP chat header. Rings the supplied
 * `peers` (the other members, already excluding self). The hosted service caps a
 * call at a handful of tiles, so the provider further trims to maxParticipants-1.
 *
 * `peers`: [{ id, name, avatar }] · `groupId`/`groupName`: originating group.
 */
export default function GroupCallButtons({ peers = [], groupId, groupName }) {
  const { theme } = useTheme();
  const {
    startGroupAudioCall, startGroupVideoCall, maxParticipants = 4,
  } = useCall();

  const trimmed = (peers || []).filter((p) => p && p.id).slice(0, maxParticipants - 1);
  const dropped = (peers || []).filter((p) => p && p.id).length - trimmed.length;

  const ring = useCallback((media) => {
    if (!trimmed.length) {
      Alert.alert('Group call', 'No other members are available to call.');
      return;
    }
    const start = media === 'video' ? startGroupVideoCall : startGroupAudioCall;
    const go = () => start?.(trimmed, { groupId, groupName });
    if (dropped > 0) {
      Alert.alert(
        'Group call',
        `Group calls support up to ${maxParticipants} people. The first ${trimmed.length} members will be rung.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Call', onPress: go }],
      );
    } else {
      go();
    }
  }, [trimmed, dropped, maxParticipants, groupId, groupName, startGroupAudioCall, startGroupVideoCall]);

  if (!trimmed.length) return null;
  const color = theme.colors.primaryTextColor;

  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={() => ring('video')} activeOpacity={0.7} style={styles.btn} hitSlop={styles.hit}>
        <Ionicons name="videocam-outline" size={23} color={color} />
      </TouchableOpacity>
      <TouchableOpacity onPress={() => ring('audio')} activeOpacity={0.7} style={styles.btn} hitSlop={styles.hit}>
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
