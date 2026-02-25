// src/AppContent.js
import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from '../navigations/RootNavigator';
import { useFonts } from 'expo-font';
import { useTheme } from '../contexts/ThemeContext';
import { useNetwork } from '../contexts/NetworkContext';
import NoInternet from '../screens/NoInternet';

// 🔔 Import updated FCM service
import { 
  getFCMToken, 
  setupNotificationCategory, 
  initializeNotifications 
} from '../firebase/fcmService';

export default function AppContent() {
  const { theme, isDarkMode } = useTheme();
  const { isConnected } = useNetwork();

  const [fontsLoaded] = useFonts({
    'Roboto-Bold': require('../../assets/fonts/Roboto-Bold.ttf'),
    'Roboto-Light': require('../../assets/fonts/Roboto-Light.ttf'),
    'Roboto-Medium': require('../../assets/fonts/Roboto-Medium.ttf'),
    'Roboto-Regular': require('../../assets/fonts/Roboto-Regular.ttf'),
    'Roboto-SemiBold': require('../../assets/fonts/Roboto-SemiBold.ttf'),
    'Poppins-Regular': require('../../assets/fonts/Poppins-Regular.ttf'),
    'Poppins-Bold': require('../../assets/fonts/Poppins-Bold.ttf'),
    'Poppins-Medium': require('../../assets/fonts/Poppins-Medium.ttf'),
    'Poppins-SemiBold': require('../../assets/fonts/Poppins-SemiBold.ttf'),
  });

  useEffect(() => {
    let isMounted = true;

    const initFCM = async () => {
      // 1️⃣ Setup Comment category for notifications
      await setupNotificationCategory();

      // 2️⃣ Get FCM token
      const token = await getFCMToken();
      if (token && isMounted) {
        console.log('FCM token ready for Backend:', token);
      }

      // 3️⃣ Initialize notifications (foreground + background + Comment button)
      const unsubscribe = initializeNotifications();

      return unsubscribe; // will be used in cleanup
    };

    let cleanup;
    initFCM().then(unsub => {
      cleanup = unsub;
    });

    return () => {
      isMounted = false;
      if (cleanup) cleanup();
    };
  }, []);

  if (!fontsLoaded) return null;
  if (!isConnected) return <NoInternet />;

  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <RootNavigator />
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />
    </SafeAreaProvider>
  );
}