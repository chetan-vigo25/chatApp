import React, { useEffect, useRef, useState } from 'react';
import { Animated, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { useNetwork } from '../contexts/NetworkContext';

// WhatsApp-style connectivity strip.
//
// Replaces the old full-screen NoInternet overlay that unmounted/covered the
// chat UI when offline. This is a slim, NON-BLOCKING banner pinned under the
// status bar: `pointerEvents="none"` lets every touch pass through to the
// cached chats behind it, so the user keeps scrolling the list and opening
// chats (all served from SQLite) while offline.
//
// Debounce: raw NetInfo `isConnected` flaps during request bursts. We only
// paint "No internet connection" after the network has been DOWN for a grace
// period (SHOW_DELAY), so transient blips never flash the strip. On reconnect
// we show a brief "Connecting…" then auto-hide (HIDE_DELAY).
const SHOW_DELAY = 2000;
const HIDE_DELAY = 1200;

export default function OfflineBanner() {
  const { theme, isDarkMode } = useTheme();
  const { isConnected } = useNetwork();
  const insets = useSafeAreaInsets();

  // 'hidden' | 'offline' | 'connecting'
  const [state, setState] = useState('hidden');
  const timerRef = useRef(null);
  const anim = useRef(new Animated.Value(0)).current;

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
    Animated.timing(anim, {
      toValue: state === 'hidden' ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [state, anim]);

  // Keep it mounted through the fade-out; nothing to render once fully hidden.
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    if (state !== 'hidden') {
      setRendered(true);
      return undefined;
    }
    const id = setTimeout(() => setRendered(false), 220);
    return () => clearTimeout(id);
  }, [state]);

  if (!rendered) return null;

  const isConnecting = state === 'connecting';
  const backgroundColor = isConnecting
    ? theme.colors.themeColor
    : (isDarkMode ? '#2A2A2A' : '#4A4A4A');
  const label = isConnecting ? 'Connecting…' : 'No internet connection';

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          backgroundColor,
          opacity: anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [-8, 0],
              }),
            },
          ],
        },
      ]}
    >
      <Text style={styles.text}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
    paddingVertical: 5,
  },
});
