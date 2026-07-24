import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from '../navigations/RootNavigator';
import { useFonts } from 'expo-font';
import { useTheme } from '../contexts/ThemeContext';
import AppBannerHost from '../../src/components/AppBannerHost';
import OfflineBanner from '../components/OfflineBanner';

export default function AppContent() {
  const { theme, isDarkMode } = useTheme();

  const [fontsLoaded] = useFonts({
    'Roboto-Black': require('../../assets/fonts/Roboto-Black.ttf'),
    'Roboto-Bold': require('../../assets/fonts/Roboto-Bold.ttf'),
    'Roboto-Light': require('../../assets/fonts/Roboto-Light.ttf'),
    'Roboto-Medium': require('../../assets/fonts/Roboto-Medium.ttf'),
    'Roboto-Regular': require('../../assets/fonts/Roboto-Regular.ttf'),
    'Roboto-SemiBold': require('../../assets/fonts/Roboto-SemiBold.ttf'),
  });

  if (!fontsLoaded) return null;

  // Offline is handled by a thin, NON-BLOCKING banner (OfflineBanner) — never a
  // full-screen overlay. RootNavigator stays mounted across network drops so the
  // navigation stack is preserved (never reset to Splash) and the cached chats
  // and messages (served from SQLite) stay fully usable with no network. The old
  // full-screen NoInternet overlay covered that cached UI; it's kept as a
  // component/route for anywhere still referencing it, just no longer shown here.
  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBannerHost />
      <RootNavigator />
      <OfflineBanner />
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />
    </SafeAreaProvider>
  );
}
