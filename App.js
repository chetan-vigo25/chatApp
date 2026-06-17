import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import RootNavigator from './src/navigations/RootNavigator';
import { useFonts } from 'expo-font';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { ContactProvider } from './src/contexts/ContactContext';
import { DeviceInfoProvider } from './src/contexts/DeviceInfoContext';
import { Provider as PaperProvider } from 'react-native-paper';
import { NetworkProvider, useNetwork } from './src/contexts/NetworkContext';
import { DeviceLocationProvider } from './src/contexts/DeviceLoc';
import { ImageProvider } from './src/contexts/ImageProvider';
import { AuthProvider } from './src/contexts/AuthContext';
import { PresenceProvider } from './src/presence/store/PresenceContext';
import { RealtimeChatProvider } from './src/contexts/RealtimeChatContext';
import AppContent from './src/screens/AppContent';
import {  getFCMToken, initializeNotifications, setupNotificationCategory, setupCallNotificationCategory } from './src/firebase/fcmService';
import { registerNotifeeForeground, ensureCallChannel } from './src/firebase/callNotifee';
import { setPushToken } from './src/Redux/Services/Socket/socket';
import 'react-native-get-random-values';
import NoInternet from './src/screens/NoInternet';
import { CallProvider } from './src/calls/CallProvider';
import CallContentInset from './src/calls/components/CallContentInset';
import AppLockGate from './src/components/AppLockGate';

import 'react-native-gesture-handler';

export default function App() {

    useEffect(() => {
      let cleanup;
      let notifeeCleanup;
      const setup = async () => {
        try {
          // Setup iOS notification categories (reply buttons etc.)
          await setupNotificationCategory();
          // Register the incoming-call category (Accept / Decline) up front so the
          // buttons appear on the FIRST call push too — on iOS the OS needs the
          // category registered before the notification arrives (Android presents
          // it locally so this is just a safe, idempotent pre-warm there).
          await setupCallNotificationCategory();

          // Get and store FCM token
          const token = await getFCMToken();
          if (token) {
            await AsyncStorage.setItem('fcmToken', token);
            console.log('FCM token stored', token);
            // Register the CURRENT token with the backend session on every boot.
            // A rebuild/reinstall (or any FCM rotation) changes the token, but the
            // backend otherwise only learns it at login — so it keeps pushing to a
            // dead token and call/message pushes report `sent: 0` while the device
            // is backgrounded/locked. setPushToken stores it + (re)registers over
            // the socket (idempotent; fires on connect if not yet connected).
            setPushToken(token);
          }

          // Setup foreground listeners (background handler is in index.js)
          cleanup = initializeNotifications();

          // Full-screen incoming-call notifications (Android): pre-create the ring
          // channel and listen for Accept/Decline taps while the app is open. The
          // cold-start launch action is replayed by CallProvider (once its call
          // listeners + auth are ready), not here — doing it here races auth
          // restore and the Accept-from-notification action gets lost.
          await ensureCallChannel();
          notifeeCleanup = registerNotifeeForeground();
        } catch (error) {
          console.error('FCM setup error:', error);
        }
      };
      setup();
      return () => {
        if (cleanup) cleanup();
        if (notifeeCleanup) notifeeCleanup();
      };
    }, []);

  return (
    <SafeAreaProvider>
     <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
       <ThemeProvider>
         <NetworkProvider>
          <PaperProvider>
           <DeviceInfoProvider>
            <AuthProvider>
              <ContactProvider>
               <ImageProvider>
                <DeviceLocationProvider>
                 <PresenceProvider>
                  <RealtimeChatProvider>
                    <CallProvider>
                      <CallContentInset>
                        <AppContent />
                        <AppLockGate />
                      </CallContentInset>
                    </CallProvider>
                  </RealtimeChatProvider>
                 </PresenceProvider>
                </DeviceLocationProvider>
               </ImageProvider>
              </ContactProvider>
            </AuthProvider>
           </DeviceInfoProvider>
          </PaperProvider>
         </NetworkProvider>
       </ThemeProvider>
     </KeyboardProvider>
    </SafeAreaProvider>
  );
}