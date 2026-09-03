import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, ToastAndroid, TouchableOpacity } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

// One copy affordance for every profile field (phone / email / username), on my
// own profile and on a peer's. Tapping copies the RAW value — not the formatted
// one on screen — so a pasted number or handle is usable as-is, and flips to a
// checkmark for ~1.5s as the confirmation.
export default function CopyFieldButton({ value, label = 'Value', size = 18, style }) {
  const { theme } = useTheme();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const text = value == null ? '' : String(value).trim();
  if (!text) return null;

  const onCopy = async () => {
    try {
      await Clipboard.setStringAsync(text);
    } catch (e) {
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
    // Android gets the usual toast; on iOS the checkmark IS the confirmation
    // (a modal Alert for a copy would be far heavier than the action).
    if (Platform.OS === 'android') ToastAndroid.show(`${label} copied`, ToastAndroid.SHORT);
  };

  return (
    <TouchableOpacity
      onPress={onCopy}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={`Copy ${label.toLowerCase()}`}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={[styles.btn, style]}
    >
      <Ionicons
        name={copied ? 'checkmark' : 'copy-outline'}
        size={size}
        color={copied ? theme.colors.themeColor : theme.colors.placeHolderTextColor}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
