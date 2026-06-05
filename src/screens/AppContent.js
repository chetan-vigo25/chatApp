// src/AppContent.js
import React, { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from '../navigations/RootNavigator';
import { useFonts } from 'expo-font';
import { useTheme } from '../contexts/ThemeContext';
import { useNetwork } from '../contexts/NetworkContext';
import { useAuth } from '../contexts/AuthContext';
import { getFCMToken } from '../firebase/fcmService';
import { setPushToken } from '../Redux/Services/Socket/socket';
import NoInternet from '../screens/NoInternet';
import AppBannerHost from '../../src/components/AppBannerHost';

export default function AppContent() {
  const { theme, isDarkMode } = useTheme();
  const { isConnected } = useNetwork();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getFCMToken();
        if (cancelled || !token) return;
        setPushToken(token);
        AsyncStorage.setItem('fcmToken', token).catch(() => {});
      } catch (_) { /* best-effort; push is non-blocking */ }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const [fontsLoaded] = useFonts({
    'Roboto-Black': require('../../assets/fonts/Roboto-Black.ttf'),
    'Roboto-Bold': require('../../assets/fonts/Roboto-Bold.ttf'),
    'Roboto-Light': require('../../assets/fonts/Roboto-Light.ttf'),
    'Roboto-Medium': require('../../assets/fonts/Roboto-Medium.ttf'),
    'Roboto-Regular': require('../../assets/fonts/Roboto-Regular.ttf'),
    'Roboto-SemiBold': require('../../assets/fonts/Roboto-SemiBold.ttf'),
  });

  if (!fontsLoaded) return null;
  if (!isConnected) return <NoInternet />;

  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBannerHost />
      <RootNavigator />
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />
    </SafeAreaProvider>
  );
}

