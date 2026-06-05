import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import CallAvatar from './CallAvatar';

/**
 * Roster grid for a GROUP audio call (and the ringing/ended states of a group
 * video call, where there is no live video yet). Shows each invited participant
 * with a small status line: "Ringing…", "In call", or "Left".
 *
 * `participants` is the call-machine roster map ({ [id]: { id,name,avatar,joined,left } }).
 * `status` is the current CALL_STATUS so we can label pre-answer "Ringing…".
 */
const statusLabel = (p, ringing) => {
  if (p.left) return 'Left';
  if (p.joined) return 'In call';
  return ringing ? 'Ringing…' : 'Connecting…';
};

export default function CallParticipantsGrid({ participants = {}, ringing = false }) {
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const onBg = isDarkMode ? '#FFFFFF' : c.primaryTextColor;
  const onBgSoft = isDarkMode ? 'rgba(255,255,255,0.65)' : c.secondaryTextColor;
  const avatarBorder = isDarkMode ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)';

  const list = Object.values(participants);
  if (!list.length) return null;
  // Size avatars down a touch as the group grows so 3-4 fit cleanly.
  const size = list.length <= 2 ? 104 : 84;

  return (
    <View style={styles.grid}>
      {list.map((p) => (
        <View key={p.id} style={styles.cell}>
          <View style={[styles.avatarWrap, { borderColor: avatarBorder }, p.left && styles.leftDim]}>
            <CallAvatar uri={p.avatar} name={p.name} id={p.id} size={size} />
          </View>
          <Text style={[styles.name, { color: onBg }]} numberOfLines={1}>{p.name || 'Unknown'}</Text>
          <Text style={[styles.status, { color: onBgSoft }, p.joined && styles.statusActive]}>
            {statusLabel(p, ringing)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 22,
    paddingHorizontal: 20,
  },
  cell: { alignItems: 'center', width: 120 },
  avatarWrap: {
    borderRadius: 60,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.16)',
    padding: 3,
  },
  leftDim: { opacity: 0.4 },
  name: {
    color: '#fff',
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    marginTop: 10,
    maxWidth: 120,
    textAlign: 'center',
  },
  status: {
    color: 'rgba(255,255,255,0.65)',
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },
  statusActive: { color: '#00D26A' },
});
