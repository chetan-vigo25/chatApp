/**
 * Empty state shown when there are no linked devices.
 */
import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';

export default function EmptyDevices() {
  const { theme } = useTheme();

  return (
    <View style={styles.container}>
      <MaterialIcons name="devices" size={64} color={theme.colors.placeHolderTextColor} />
      <Text style={[styles.title, { color: theme.colors.primaryTextColor }]}>
        No Linked Devices
      </Text>
      <Text style={[styles.subtitle, { color: theme.colors.placeHolderTextColor }]}>
        Link your web or desktop client by scanning the QR code displayed on that device.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingVertical: 60,
  },
  title: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    marginTop: 16,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 19,
  },
});