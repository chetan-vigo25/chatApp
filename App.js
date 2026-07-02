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
import { getFCMToken, initializeNotifications, setupNotificationCategory, setupCallNotificationCategory } from './src/firebase/fcmService';
import { registerNotifeeForeground, ensureCallChannel } from './src/firebase/callNotifee';
import { setPushToken } from './src/Redux/Services/Socket/socket';
import 'react-native-get-random-values';
import NoInternet from './src/screens/NoInternet';
import { CallProvider } from './src/calls/CallProvider';
import CallContentInset from './src/calls/components/CallContentInset';
import AppLockGate from './src/components/AppLockGate';
import { CellInfoModule } from 'expo-cell-info';

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

        // AFTER notification permission has been asked/resolved above (getFCMToken
        // → requestNotificationPermission awaits the POST_NOTIFICATIONS dialog),
        // request location + read the serving cell. Running it here — rather than
        // in a parallel effect — guarantees the two runtime dialogs appear one at
        // a time (Android shows only one at once; racing them dropped the
        // notification prompt and hung the location request).
        await logCellInfo();
      };

      // Reads the serving cell tower(s) and logs the cell IDs. Android-only;
      // no-op on iOS / Expo Go. Requests FINE location if not already granted.
      const logCellInfo = async () => {
        try {
          const available = CellInfoModule.isAvailable();
          console.log('CellInfo: isAvailable =', available);
          if (!available) {
            console.log('CellInfo: native module missing — rebuild with `npx expo run:android` (Android-only, not Expo Go)');
            return;
          }

          if (!CellInfoModule.hasPermissions()) {
            const perm = await CellInfoModule.requestPermissionsAsync();
            console.log('CellInfo: permission result =', perm);
            // Gate on FINE location ONLY. hasPermissions() checks just
            // ACCESS_FINE_LOCATION, whereas perm.granted is an aggregate that
            // also folds in the optional READ_PHONE_STATE — so perm.granted can
            // read false even when location itself was granted. Re-checking here
            // avoids that false negative. If this is still false, the user picked
            // "Approximate" (coarse) — getAllCellInfo needs "Precise".
            if (!CellInfoModule.hasPermissions()) {
              console.log('CellInfo: FINE location not granted — pick "Precise" in the dialog');
              return;
            }
          }

          const cells = await CellInfoModule.getAllCellInfo({ includeNeighbors: false });
          console.log(`CellInfo: got ${cells.length} serving cell(s) ->`, cells);
          if (cells.length === 0) {
            console.log('CellInfo: empty — likely an emulator/no SIM (no cellular modem)');
          }

          cells.forEach((c) => {
            // The "cell id" field name differs per radio type.
            const cellId = c.ci ?? c.cid ?? c.nci ?? c.basestationId ?? null;
            console.log(
              `CellInfo[${c.cellType}] id=${cellId} pci=${c.pci ?? '-'} ` +
              `mcc/mnc=${c.mcc ?? '-'}/${c.mnc ?? '-'} ` +
              `dbm=${c.dbm ?? '-'} (${c.signalStrength})`
            );
          });
        } catch (error) {
          console.error('CellInfo error:', error?.code, error?.message);
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