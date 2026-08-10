import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Image, Text, ActivityIndicator, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '../../../contexts/ThemeContext';
import permissionManager from '../data/PermissionManager';
import { markOnboardingCompleted } from '../data/permissionStorage';
import { releaseNotificationPrompt } from '../notificationPromptGate';

/**
 * PermissionsGate — the one-time startup permission step.
 *
 * STEP 1 — Prominent disclosure (Google Play "User Data" policy / Apple
 * transparency): BEFORE any runtime permission dialog fires, the user is shown
 * exactly WHAT data the app collects while in use (location at login/calls,
 * device details) and WHY, and must take an affirmative action ("Continue").
 * This in-app disclosure is required IN ADDITION to the OS dialogs — data
 * collection that isn't obvious to the user (location attached to logins and
 * calls) must be disclosed prominently, not only in the OS rationale string.
 *
 * STEP 2 — After Continue, this screen fires the NATIVE Android/iOS permission
 * dialogs, one after another, for every permission the app uses (except
 * Contacts, which is asked in context by its own feature). Each system dialog
 * carries the OS usage string as its rationale.
 *
 * Once every dialog has been answered (granted or not — we never force or fake
 * a grant), onboarding is marked complete and the app navigates to its real
 * destination. App entry is NOT blocked on any permission: individual features
 * re-ask in context if something was denied, and denying location never blocks
 * chat or calls.
 */
export default function PermissionsGate({ navigation, route }) {
  const { theme } = useTheme();
  const ranRef = useRef(false);
  const [accepted, setAccepted] = useState(false);

  const nextRoute = route?.params?.nextRoute || { name: 'UserAgree' };

  const runPermissions = useCallback(() => {
    // Guard against React 18 double-invoke / double-taps firing the dialogs twice.
    if (ranRef.current) return;
    ranRef.current = true;

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
        navigation.reset({
          index: 0,
          routes: [{ name: nextRoute.name, params: nextRoute.params }],
        });
      }
    };

    run();
  }, [navigation, nextRoute]);

  useEffect(() => {
    if (accepted) runPermissions();
  }, [accepted, runPermissions]);

  if (!accepted) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <ScrollView
          contentContainerStyle={styles.disclosureScroll}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.smallLogoWrap}>
            <Image
              source={require('../../../../assets/icon0.png')}
              resizeMode="contain"
              style={styles.smallLogo}
            />
          </View>

          <Text style={[styles.title, { color: theme.colors.primaryTextColor }]}>
            Your data & permissions
          </Text>
          <Text style={[styles.intro, { color: theme.colors.secondaryTextColor }]}>
            To keep TalksTry safe for everyone, the app collects the following
            while you are using it:
          </Text>

          <View style={styles.bulletRow}>
            <View style={[styles.bulletDot, { backgroundColor: theme.colors.themeColor }]} />
            <Text style={[styles.bulletText, { color: theme.colors.primaryTextColor }]}>
              <Text style={styles.bulletLead}>Location</Text> — collected only
              at sign-in and at the moment you place a call, to protect
              accounts against fraud, spam and misuse. It is never collected
              in the background or while you simply use the app.
            </Text>
          </View>
          <View style={styles.bulletRow}>
            <View style={[styles.bulletDot, { backgroundColor: theme.colors.themeColor }]} />
            <Text style={[styles.bulletText, { color: theme.colors.primaryTextColor }]}>
              <Text style={styles.bulletLead}>Device details</Text> — model, OS
              and app version, network type and IP address, used for session
              security, call reliability and support.
            </Text>
          </View>
          <View style={styles.bulletRow}>
            <View style={[styles.bulletDot, { backgroundColor: theme.colors.themeColor }]} />
            <Text style={[styles.bulletText, { color: theme.colors.primaryTextColor }]}>
              <Text style={styles.bulletLead}>Your choice</Text> — you can deny
              location access in the next step; chat and calls keep working.
              Permissions can be changed anytime in system settings.
            </Text>
          </View>

          <Text style={[styles.footnote, { color: theme.colors.secondaryTextColor }]}>
            Next, your device will ask for the app's permissions.
          </Text>
        </ScrollView>

        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.continueBtn, { backgroundColor: theme.colors.themeColor }]}
          onPress={() => setAccepted(true)}
        >
          <Text style={styles.continueText}>Continue</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

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
  disclosureScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingTop: 32,
    paddingBottom: 16,
  },
  smallLogoWrap: {
    width: 84,
    height: 84,
    alignSelf: 'center',
    marginBottom: 20,
  },
  smallLogo: {
    width: '100%',
    height: '100%',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 10,
  },
  intro: {
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 22,
    opacity: 0.85,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  bulletDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 7,
    marginRight: 12,
  },
  bulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 21,
  },
  bulletLead: {
    fontWeight: '700',
  },
  footnote: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 8,
    opacity: 0.7,
  },
  continueBtn: {
    alignSelf: 'stretch',
    marginHorizontal: 28,
    marginBottom: 24,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  continueText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});
