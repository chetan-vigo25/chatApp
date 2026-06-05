import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import CallAvatar from './CallAvatar';

/**
 * Incoming-call screen body: caller identity + audio/video label + the
 * Accept / Decline actions. Theme-aware (sits on the chat wallpaper): text
 * adapts to light/dark; the green Accept / red Decline stay constant.
 */
export default function IncomingCallCard({ peer, displayName, media, onAccept, onReject }) {
  const isVideo = media === 'video';
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const onBg = isDarkMode ? '#FFFFFF' : c.primaryTextColor;
  const onBgSoft = isDarkMode ? 'rgba(255,255,255,0.8)' : c.secondaryTextColor;
  const avatarBorder = isDarkMode ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)';

  return (
    <View style={styles.wrap}>
      <View style={styles.top}>
        <Text style={[styles.incomingLabel, { color: onBgSoft }]}>
          {isVideo ? 'Incoming video call' : 'Incoming voice call'}
        </Text>
        <View style={[styles.avatarWrap, { borderColor: avatarBorder }]}>
          <CallAvatar uri={peer?.avatar} name={peer?.name} id={peer?.id} size={140} />
        </View>
        <Text style={[styles.name, { color: onBg }]} numberOfLines={1}>{displayName || peer?.name || 'Unknown'}</Text>
        <View style={styles.mediaRow}>
          <Ionicons name={isVideo ? 'videocam' : 'call'} size={15} color={onBgSoft} />
          <Text style={[styles.mediaText, { color: onBgSoft }]}>{isVideo ? 'Video' : 'Voice'}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <View style={styles.actionItem}>
          <TouchableOpacity activeOpacity={0.85} onPress={onReject} style={[styles.action, styles.decline]}>
            <MaterialIcons name="call-end" size={32} color="#fff" />
          </TouchableOpacity>
          <Text style={[styles.actionLabel, { color: onBgSoft }]}>Decline</Text>
        </View>
        <View style={styles.actionItem}>
          <TouchableOpacity activeOpacity={0.85} onPress={onAccept} style={[styles.action, styles.accept]}>
            <Ionicons name={isVideo ? 'videocam' : 'call'} size={30} color="#fff" />
          </TouchableOpacity>
          <Text style={[styles.actionLabel, { color: onBgSoft }]}>Accept</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'space-between', alignItems: 'center', paddingVertical: 48 },
  top: { alignItems: 'center', marginTop: 40 },
  incomingLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    marginBottom: 28,
  },
  avatarWrap: {
    borderRadius: 80,
    borderWidth: 3,
    padding: 3,
  },
  name: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 26,
    marginTop: 22,
    maxWidth: '80%',
    textAlign: 'center',
  },
  mediaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  mediaText: { fontFamily: 'Roboto-Regular', fontSize: 13 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    paddingHorizontal: 40,
  },
  actionItem: { alignItems: 'center', gap: 10 },
  action: {
    width: 70, height: 70, borderRadius: 35,
    alignItems: 'center', justifyContent: 'center',
  },
  decline: { backgroundColor: '#EA0038' },
  accept: { backgroundColor: '#00C853' },
  actionLabel: { fontFamily: 'Roboto-Regular', fontSize: 13 },
});
