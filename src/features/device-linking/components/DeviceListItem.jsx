import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import { formatDistanceToNow, format, isToday, isYesterday } from 'date-fns';

// Choose a glyph + tint from the device/browser/OS hints. We only use
// FontAwesome6 *solid* glyphs (brand glyphs live in a separate font that this
// component doesn't load), but keep a per-browser accent so each row still
// reads at a glance — like the colourful favicons WhatsApp shows.
function resolveIcon(type, platform, browser) {
  const blob = `${type} ${platform} ${browser}`.toLowerCase();
  if (blob.includes('chrome')) return { name: 'globe', color: '#4285F4' };
  if (blob.includes('firefox')) return { name: 'globe', color: '#FF7139' };
  if (blob.includes('safari')) return { name: 'compass', color: '#1B88CA' };
  if (blob.includes('edge')) return { name: 'globe', color: '#27A0E5' };
  if (blob.includes('mobile') || blob.includes('android') || blob.includes('iphone')) {
    return { name: 'mobile-screen-button', color: 'brand' };
  }
  if (blob.includes('mac') || blob.includes('windows') || blob.includes('linux') || blob.includes('desktop')) {
    return { name: 'display', color: '#54656F' };
  }
  return { name: 'globe', color: '#54656F' };
}

// WhatsApp-style "Last active today at 3:15 PM" label.
function lastActiveLabel(date) {
  if (!date) return '';
  try {
    const d = new Date(date);
    if (isToday(d)) return `Last active today at ${format(d, 'h:mm a')}`;
    if (isYesterday(d)) return `Last active yesterday at ${format(d, 'h:mm a')}`;
    return `Last active ${formatDistanceToNow(d, { addSuffix: true })}`;
  } catch {
    return '';
  }
}

export default function DeviceListItem({ device, onPress }) {
  const { theme } = useTheme();

  const info = device.deviceInfo || device;
  const name = info.deviceName || device.deviceName || 'Unknown Device';
  const type = info.deviceType || device.deviceType || 'web';
  const platform = info.platform || device.platform || '';
  const browser = info.browser || device.browser || '';
  const os = info.os || device.os || '';
  const isActive = device.isActive === true || device.status === 'active';
  const glyph = resolveIcon(type, platform, browser);
  // 'brand' is a sentinel meaning "use the app's theme accent".
  const glyphColor = glyph.color === 'brand' ? theme.colors.themeColor : glyph.color;

  // Build a WhatsApp-like title: "Google Chrome (Linux)"
  const titleBrowser = browser || (type === 'web' ? 'Web' : 'Device');
  const titlePlatform = os || platform;
  const title = info.deviceName
    ? name
    : titlePlatform
      ? `${titleBrowser} (${titlePlatform})`
      : titleBrowser;

  const subtitle = isActive
    ? 'Active now'
    : lastActiveLabel(device.lastActive || device.lastActivity) || 'Last active recently';

  const unlinkRed = '#EF4444';

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.6} style={styles.row}>
      <View style={[styles.iconCircle, { backgroundColor: theme.colors.menuBackground }]}>
        <FontAwesome6 name={glyph.name} size={24} color={glyphColor} />
      </View>
      <View style={styles.textCol}>
        <Text style={[styles.name, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.sub, { color: theme.colors.secondaryTextColor }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      {/* Trailing unlink icon — tap it (or the row) to log this device out. */}
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.6}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={[styles.unlinkBtn, { backgroundColor: unlinkRed + '14' }]}
      >
        <FontAwesome6 name="link-slash" size={15} color={unlinkRed} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 18,
  },
  iconCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: { flex: 1 },
  name: { fontFamily: 'Roboto-Regular', fontSize: 17, letterSpacing: -0.2 },
  sub: { fontFamily: 'Roboto-Regular', fontSize: 13.5, marginTop: 3 },
  unlinkBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
