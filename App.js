import React, { useEffect } from 'react';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { NetworkProvider } from './src/contexts/NetworkContext';
import { Provider as PaperProvider } from 'react-native-paper';
import { DeviceInfoProvider } from './src/contexts/DeviceInfoContext';
import { ContactProvider } from './src/contexts/ContactContext';
import { ImageProvider } from './src/contexts/ImageProvider';
import { DeviceLocationProvider } from './src/contexts/DeviceLoc';
import AppContent from './src/screens/AppContent';
import {  getFCMToken, initializeNotifications, setupNotificationCategory } from './src/firebase/fcmService';

// Register background FCM handler

export default function App() {
  useEffect(() => {
    const setup = async () => {
      const token = await getFCMToken();
      console.log('Device FCM token ready:', token);

      const unsubscribe = initializeNotifications();
      return unsubscribe;
    };

    let cleanup;
    setup().then(unsub => {
      cleanup = unsub;
    });

    return () => cleanup && cleanup();
  }, []);
  return (
    <ThemeProvider>
      <NetworkProvider>
        <PaperProvider>
          <DeviceInfoProvider>
            <ContactProvider>
              <ImageProvider>
                <DeviceLocationProvider>
                  <AppContent />
                </DeviceLocationProvider>
              </ImageProvider>
            </ContactProvider>
          </DeviceInfoProvider>
        </PaperProvider>
      </NetworkProvider>
    </ThemeProvider>
  );
}