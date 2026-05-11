import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import { formatDistanceToNow, format } from 'date-fns';

const DEVICE_ICONS = {
  web: 'globe',
  desktop: 'desktop',
  mobile: 'mobile-screen',
};

export default function DeviceListItem({ device, onPress }) {
  const { theme } = useTheme();

  const info = device.deviceInfo || device;
  const name = info.deviceName || device.deviceName || 'Unknown Device';
  const type = info.deviceType || device.deviceType || 'web';
  const platform = info.platform || device.platform || '';
  const browser = info.browser || device.browser || '';
  const os = info.os || device.os || '';
  const isActive = device.isActive === true || device.status === 'active';
  const iconName = DEVICE_ICONS[type] || DEVICE_ICONS.web;

  const detailParts = [platform, browser, os].filter(Boolean);
  const detailLine = detailParts.join(' \u00B7 ');

  let lastActiveLabel = '';
  const lastActiveDate = device.lastActive || device.lastActivity;
  if (lastActiveDate) {
    try {
      lastActiveLabel = formatDistanceToNow(new Date(lastActiveDate), { addSuffix: true });
    } catch {}
  }

  let linkedLabel = '';
  const linkedDate = device.linkedAt || device.createdAt;
  if (linkedDate) {
    try {
      linkedLabel = format(new Date(linkedDate), 'MMM d, yyyy');
    } catch {}
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.container}
    >
      <View style={[styles.iconCircle, { borderColor: theme.colors.themeColor }]}>
        <FontAwesome6 name={iconName} size={20} color={theme.colors.themeColor} />
        {isActive && <View style={styles.activeDot} />}
      </View>

      <View style={styles.textContainer}>
        <Text
          style={[styles.deviceName, { color: theme.colors.primaryTextColor }]}
          numberOfLines={1}
        >
          {name}
        </Text>

        {detailLine ? (
          <Text
            style={[styles.subtitle, { color: theme.colors.placeHolderTextColor }]}
            numberOfLines={1}
          >
            {detailLine}
          </Text>
        ) : null}

        <View style={styles.metaRow}>
          {lastActiveLabel ? (
            <Text style={[styles.meta, { color: theme.colors.placeHolderTextColor }]}>
              {isActive ? 'Active now' : `Last active: ${lastActiveLabel}`}
            </Text>
          ) : null}
          {linkedLabel ? (
            <Text style={[styles.meta, { color: theme.colors.placeHolderTextColor }]}>
              {lastActiveLabel ? ' \u00B7 ' : ''}Linked: {linkedLabel}
            </Text>
          ) : null}
        </View>
      </View>

      <FontAwesome6 name="chevron-right" size={12} color={theme.colors.placeHolderTextColor} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 12,
  },
  iconCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeDot: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#25D366',
    borderWidth: 2,
    borderColor: '#fff',
  },
  textContainer: {
    flex: 1,
  },
  deviceName: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
  subtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 2,
  },
  meta: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
  },
});