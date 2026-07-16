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
 * `activeSpeakerId` is whoever the SFU currently hears — their avatar gets a green
 * speaking ring, so in a group you can see who is talking.
 */
const statusLabel = (p, ringing) => {
  if (p.left) return 'Left';
  if (p.joined) return 'In call';
  return ringing ? 'Ringing…' : 'Connecting…';
};

export default function CallParticipantsGrid({ participants = {}, ringing = false, activeSpeakerId = null }) {
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const onBg = isDarkMode ? '#FFFFFF' : c.primaryTextColor;
  const onBgSoft = isDarkMode ? 'rgba(255,255,255,0.65)' : c.secondaryTextColor;
  const avatarBorder = isDarkMode ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)';

  const list = Object.values(participants);
  if (!list.length) return null;
  // Size avatars down as the group grows so larger rosters still fit on screen.
  const size = list.length <= 2 ? 104 : list.length <= 6 ? 84 : 64;

  return (
    <View style={styles.grid}>
      {list.map((p) => (
        <View key={p.id} style={styles.cell}>
          <View style={[
            styles.avatarWrap,
            { borderColor: avatarBorder },
            p.left && styles.leftDim,
            // Only a live participant can be the speaker; a stale relay for someone
            // who already left must not light their tile up.
            p.joined && !p.left && String(p.id) === String(activeSpeakerId) && styles.speaking,
          ]}>
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
  speaking: { borderColor: '#00D26A' },
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
