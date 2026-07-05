import React from 'react';
import { StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

/**
 * Small "verified" check shown next to a user's name across the app (chat list,
 * contacts, call logs, group members, status, settings, …). Renders nothing
 * when `verified` is falsy, so callers can drop it in unconditionally:
 *
 *   <Text>{name}</Text>
 *   <VerifiedBadge verified={user?.isVerified} />
 *
 * Defaults to the brand/logo colour, used everywhere including the profile page.
 */
const VerifiedBadge = ({ verified, size = 15, color, style }) => {
  const { theme } = useTheme();
  if (!verified) return null;
  return (
    <Ionicons
      name="checkmark-circle"
      size={size}
      color={color || theme.colors.themeColor}
      style={[styles.badge, style]}
    />
  );
};

const styles = StyleSheet.create({
  badge: { marginLeft: 4 },
});

export default React.memo(VerifiedBadge);
