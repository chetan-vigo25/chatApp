import React, { useEffect, useState, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from '../navigations/RootNavigator';
import { useFonts } from 'expo-font';
import { useTheme } from '../contexts/ThemeContext';
import { useNetwork } from '../contexts/NetworkContext';
import { useAuth } from '../contexts/AuthContext';
import NoInternet from '../screens/NoInternet';
import AppBannerHost from '../../src/components/AppBannerHost';

export default function AppContent() {
  const { theme, isDarkMode } = useTheme();
  const { isConnected } = useNetwork();
  const { isAuthenticated } = useAuth();

  const [fontsLoaded] = useFonts({
    'Roboto-Black': require('../../assets/fonts/Roboto-Black.ttf'),
    'Roboto-Bold': require('../../assets/fonts/Roboto-Bold.ttf'),
    'Roboto-Light': require('../../assets/fonts/Roboto-Light.ttf'),
    'Roboto-Medium': require('../../assets/fonts/Roboto-Medium.ttf'),
    'Roboto-Regular': require('../../assets/fonts/Roboto-Regular.ttf'),
    'Roboto-SemiBold': require('../../assets/fonts/Roboto-SemiBold.ttf'),
  });

  // Show the full-screen offline UI only after the network has been DOWN for a
  // grace period, and hide it immediately on reconnect.
  //
  // Why this matters: raw NetInfo `isConnected` toggles constantly during
  // request bursts — exactly while the chat list/messages are loading. The old
  // code did `if (!isConnected) return <NoInternet/>`, which UNMOUNTED
  // RootNavigator on every blip; the remount reset the stack to its
  // initialRouteName ("Splash"), so the splash screen flashed back repeatedly
  // mid-session. We now keep RootNavigator ALWAYS mounted and overlay
  // NoInternet, and only after a debounce — so transient drops are invisible,
  // navigation state is never lost, and the splash never reappears.
  const [showOffline, setShowOffline] = useState(false);
  const offlineTimerRef = useRef(null);
  useEffect(() => {
    if (offlineTimerRef.current) {
      clearTimeout(offlineTimerRef.current);
      offlineTimerRef.current = null;
    }
    if (isConnected) {
      setShowOffline(false);
      return undefined;
    }
    offlineTimerRef.current = setTimeout(() => setShowOffline(true), 2500);
    return () => {
      if (offlineTimerRef.current) {
        clearTimeout(offlineTimerRef.current);
        offlineTimerRef.current = null;
      }
    };
  }, [isConnected]);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBannerHost />
      {/* RootNavigator stays mounted across network drops so the navigation
          stack (and the screen the user is on) is preserved — never reset to
          Splash. NoInternet is an overlay, not a navigator-unmounting branch. */}
      <RootNavigator />
      {showOffline && (
        <View style={StyleSheet.absoluteFill} pointerEvents="auto">
          <NoInternet />
        </View>
      )}
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />
    </SafeAreaProvider>
  );
}
