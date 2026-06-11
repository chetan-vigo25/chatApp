/**
 * Empty state shown when there are no linked devices — a soft brand halo
 * around a device glyph with a friendly hint.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';

export default function EmptyDevices() {
  const { theme } = useTheme();
  const accent = theme.colors.themeColor;

  return (
    <View style={styles.container}>
      <View style={[styles.haloOuter, { backgroundColor: accent + '0D' }]}>
        <View style={[styles.haloInner, { backgroundColor: accent + '14' }]}>
          <MaterialCommunityIcons name="laptop" size={40} color={accent} />
        </View>
      </View>
      <Text style={[styles.title, { color: theme.colors.primaryTextColor }]}>
        No devices linked yet
      </Text>
      <Text style={[styles.subtitle, { color: theme.colors.secondaryTextColor }]}>
        Open the web or desktop app, then scan the QR code to instantly link it here.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 44,
    paddingVertical: 40,
  },
  haloOuter: {
    width: 116,
    height: 116,
    borderRadius: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },
  haloInner: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    marginTop: 20,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13.5,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
});
