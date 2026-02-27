import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigations/RootNavigator';
import { useFonts } from 'expo-font';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { ContactProvider } from './src/contexts/ContactContext';
import { DeviceInfoProvider } from './src/contexts/DeviceInfoContext';
import { Provider as PaperProvider } from 'react-native-paper';
import { NetworkProvider, useNetwork } from './src/contexts/NetworkContext';
import { DeviceLocationProvider } from './src/contexts/DeviceLoc';
import { ImageProvider } from './src/contexts/ImageProvider';
import { PresenceProvider } from './src/presence/store/PresenceContext';
import { RealtimeChatProvider } from './src/contexts/RealtimeChatContext';
import AppContent from './src/screens/AppContent';
import {  getFCMToken, initializeNotifications, setupNotificationCategory } from './src/firebase/fcmService';
import 'react-native-get-random-values';

import NoInternet from './src/screens/NoInternet';

import 'react-native-gesture-handler';

export default function App() {

    useEffect(() => {
     let cleanup;
   
     const setup = async () => {
       try {
         const token = await getFCMToken();
         if (token) {
           await AsyncStorage.setItem('fcmToken', token);
           console.log('Device FCM token saved:', token);
         }
         cleanup = initializeNotifications();
       } catch (error) {
         console.log('FCM setup error:', error);
       }
     };
     setup();
     return () => {
       if (cleanup) cleanup();
     };
   }, []);

  return (
    <ThemeProvider>
      <NetworkProvider>
       <PaperProvider>
         <DeviceInfoProvider>
           <ContactProvider>
            <ImageProvider>
             <DeviceLocationProvider>
                <PresenceProvider>
                  <RealtimeChatProvider>
                    <AppContent />
                  </RealtimeChatProvider>
                </PresenceProvider>
             </DeviceLocationProvider>
            </ImageProvider>
           </ContactProvider>
         </DeviceInfoProvider>
       </PaperProvider>
      </NetworkProvider>
    </ThemeProvider>
  );
}
