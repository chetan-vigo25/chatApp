import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { useNetwork } from '../contexts/NetworkContext';

// WhatsApp-style connectivity strip.
//
// IN-FLOW (not an absolute overlay): rendered ABOVE RootNavigator in
// AppContent's column, its animated HEIGHT pushes the whole app UI down —
// the old absolute version sat ON TOP of the status bar + screen headers and
// visually collapsed/covered them while offline. `pointerEvents="none"` keeps
// every touch working; cached chats (SQLite) stay fully usable offline.
//
// Debounce: raw NetInfo `isConnected` flaps during request bursts. We only
// paint "No internet connection" after the network has been DOWN for a grace
// period (SHOW_DELAY), so transient blips never flash the strip. On reconnect
// we show a brief teal "Connecting…" then smoothly collapse (HIDE_DELAY).
const SHOW_DELAY = 2000;
const HIDE_DELAY = 1400;
const STRIP_HEIGHT = 30;

export default function OfflineBanner() {
  const { theme, isDarkMode } = useTheme();
  const { isConnected } = useNetwork();
  const insets = useSafeAreaInsets();

  // 'hidden' | 'offline' | 'connecting'
  const [state, setState] = useState('hidden');
  const timerRef = useRef(null);
  // Animates the container HEIGHT (0 → status inset + strip) so the app UI
  // slides down/up with the banner instead of being covered by it.
  const heightAnim = useRef(new Animated.Value(0)).current;
  const targetHeight = (insets.top || 0) + STRIP_HEIGHT;

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!isConnected) {
      // Debounce showing the offline strip so brief drops don't flicker it.
      timerRef.current = setTimeout(() => setState('offline'), SHOW_DELAY);
    } else {
      // Reconnected. Only transition through "Connecting…" if the strip was
      // actually visible; a blip that never showed it just stays hidden.
      setState((prev) => (prev === 'hidden' ? 'hidden' : 'connecting'));
      timerRef.current = setTimeout(() => setState('hidden'), HIDE_DELAY);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isConnected]);

  useEffect(() => {
    // Height animates on the JS driver (layout prop) — smooth ease both ways.
    Animated.timing(heightAnim, {
      toValue: state === 'hidden' ? 0 : targetHeight,
      duration: 260,
      easing: state === 'hidden' ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [state, targetHeight, heightAnim]);

  const isConnecting = state === 'connecting';
  const backgroundColor = isConnecting
    ? theme.colors.themeColor
    : (isDarkMode ? '#2A2A2A' : '#4A4A4A');
  const label = isConnecting ? 'Connecting…' : 'No internet connection';

  // NOTE: no paddingTop on the animated container — in Yoga, padding acts as a
  // MINIMUM size for the node, so `height: 0` + `paddingTop: insets.top` still
  // rendered an insets.top-tall empty strip while hidden, pushing the whole app
  // (headers, logo) down. Instead the label lives in an inner strip pinned to
  // the BOTTOM of the container; the status-bar inset area is pure backdrop and
  // the container truly collapses to 0 when hidden.
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        {
          height: heightAnim,
          backgroundColor,
        },
      ]}
    >
      {state !== 'hidden' ? (
        <View style={styles.strip}>
          <Text style={styles.text} numberOfLines={1}>{label}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  strip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: STRIP_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
  },
});
