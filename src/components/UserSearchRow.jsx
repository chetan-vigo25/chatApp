import React, { memo } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import VerifiedBadge from './VerifiedBadge';

/**
 * One person in a search result — someone you do NOT have a chat with yet.
 *
 * Deliberately a HALF-STEP away from a chat row: same height and avatar so the
 * results read as one continuous list, but no time, no unread pill and no
 * ticks, because none of those exist yet. The subtitle carries the thing that
 * made this person match — their @username or their number — so a search for
 * "9988" visibly explains itself.
 */

const AVATAR_COLORS = [
  '#E8A33D', '#4CAF93', '#5B8DEF', '#C55D8A',
  '#7C6CD6', '#3FA9C9', '#D4756B', '#6BA86B',
];

const avatarColorFor = (name) => {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const UserSearchRow = memo(function UserSearchRow({
  name,
  subtitle,
  avatarUri,
  isVerified,
  busy,
  textColor,
  subTextColor,
  themeColor,
  onPress,
}) {
  const label = name || subtitle || '?';
  const initials = String(label).charAt(0).toUpperCase();

  return (
    <TouchableOpacity
      activeOpacity={0.6}
      onPress={busy ? undefined : onPress}
      style={styles.row}
    >
      <View style={styles.avatarWrap}>
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={styles.avatar} resizeMode="cover" fadeDuration={0} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: avatarColorFor(label) }]}>
            <Text style={styles.initials}>{initials}</Text>
          </View>
        )}
      </View>

      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: textColor }]} numberOfLines={1}>
            {label}
          </Text>
          <VerifiedBadge verified={isVerified} size={14} />
        </View>
        {!!subtitle && (
          <Text style={[styles.subtitle, { color: subTextColor }]} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>

      {busy ? <ActivityIndicator size="small" color={themeColor} /> : null}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 64,
    gap: 14,
  },
  avatarWrap: { width: 48, height: 48, borderRadius: 24, overflow: 'hidden' },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  info: { flex: 1, justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: { fontFamily: 'Roboto-Medium', fontSize: 15, lineHeight: 21, flexShrink: 1 },
  subtitle: { fontFamily: 'Roboto-Regular', fontSize: 13, lineHeight: 18, marginTop: 1 },
});

export default UserSearchRow;
