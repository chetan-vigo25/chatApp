import React, { useEffect, useRef } from 'react';
import { View, Image, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '../../../contexts/ThemeContext';
import permissionManager from '../data/PermissionManager';
import { markOnboardingCompleted } from '../data/permissionStorage';
import { releaseNotificationPrompt } from '../notificationPromptGate';

/**
 * PermissionsGate — the one-time startup permission step.
 *
 * There is NO custom "Allow" list UI. Right after Splash this screen simply fires
 * the NATIVE Android/iOS permission dialogs, one after another, for every
 * permission the app uses (except Contacts, which is asked in context by its own
 * feature). Each system dialog carries the OS usage string as its rationale, so
 * both stores' disclosure requirement is still met.
 *
 * Visually it mirrors Splash (app icon on the app background) so the native
 * dialogs appear to pop over the launch screen — the user never sees a separate
 * "permission screen".
 *
 * Once every dialog has been answered (granted or not — we never force or fake a
 * grant), onboarding is marked complete and the app navigates to its real
 * destination. App entry is NOT blocked on any permission: individual features
 * re-ask in context if something was denied.
 *
 * The admin-controlled location tracking consent (TrackingConsentSheet) is a
 * SEPARATE, later flow and is intentionally untouched here — it still appears
 * mid-session only when the organization enables tracking.
 */
export default function PermissionsGate({ navigation, route }) {
  const { theme } = useTheme();
  const ranRef = useRef(false);

  const nextRoute = route?.params?.nextRoute || { name: 'UserAgree' };

  useEffect(() => {
    // Guard against React 18 double-invoke / re-mounts firing the dialogs twice.
    if (ranRef.current) return undefined;
    ranRef.current = true;

    let cancelled = false;

    const run = async () => {
      try {
        // Sequentially raise every applicable OS permission dialog.
        await permissionManager.requestAllSequentially();
      } catch (_err) {
        // A permission hiccup must never wedge the user on this screen.
      } finally {
        // The FCM boot path may now prompt normally again on later launches.
        releaseNotificationPrompt();
        await markOnboardingCompleted();

        if (!cancelled) {
          navigation.reset({
            index: 0,
            routes: [{ name: nextRoute.name, params: nextRoute.params }],
          });
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [navigation, nextRoute]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.logoWrap}>
        <Image
          source={require('../../../../assets/icon0.png')}
          resizeMode="contain"
          style={styles.logo}
        />
      </View>
      <ActivityIndicator color={theme.colors.themeColor} style={styles.spinner} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoWrap: {
    width: 200,
    height: 200,
  },
  logo: {
    width: '100%',
    height: '100%',
  },
  spinner: {
    position: 'absolute',
    bottom: 60,
  },
});
