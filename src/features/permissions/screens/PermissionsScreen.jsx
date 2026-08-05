import React, { useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { APP_TAG_NAME } from '@env';

import { useTheme } from '../../../contexts/ThemeContext';
import usePermissionFlow from '../viewmodel/usePermissionFlow';
import PermissionListItem from '../ui/PermissionListItem';
import { withAlpha } from '../ui/colorUtils';

/**
 * Permission Introduction screen.
 *
 * Shown once, immediately after Splash, for users who have not yet been through the
 * permission flow. Its entire job is to EXPLAIN why each permission is needed before
 * the operating system asks — it does not, and cannot, replace or fake the native
 * dialogs: every Allow tap goes through the PermissionManager straight to the OS.
 *
 * Contacts is intentionally not listed here; it is requested in context by the
 * contacts sync feature, where the user can see what it is for.
 *
 * Navigation contract: `route.params.nextRoute = { name, params }` — the destination
 * Splash resolved. It is replayed with `reset` so the permission screen never stays
 * on the back stack.
 */
export default function PermissionsScreen({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const colors = theme.colors;

  const {
    items,
    isLoading,
    isWorking,
    allRequiredGranted,
    blockedItems,
    pendingCount,
    requestOne,
    openSettings,
    completeFlow,
  } = usePermissionFlow();

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const navigatingRef = useRef(false);

  const nextRoute = route?.params?.nextRoute || { name: 'UserAgree' };

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 320,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  // One tap → one native dialog for that row only. Nothing is chained.
  const handleAllow = useCallback((item) => requestOne(item.id), [requestOne]);

  const handleContinue = useCallback(async () => {
    // Guard against a double tap resetting the stack twice.
    if (!allRequiredGranted || navigatingRef.current) return;
    navigatingRef.current = true;

    await completeFlow();
    navigation.reset({
      index: 0,
      routes: [{ name: nextRoute.name, params: nextRoute.params }],
    });
  }, [allRequiredGranted, completeFlow, navigation, nextRoute]);

  const continueEnabled = allRequiredGranted && !isWorking;

  return (
    <Animated.View style={[styles.root, { opacity: fadeAnim, backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* ── Hero ───────────────────────────────────────────────────────────── */}
        <View style={styles.hero}>
          <View style={[styles.heroBadge, { backgroundColor: withAlpha(colors.themeColor, isDarkMode ? 0.2 : 0.12) }]}>
            <Ionicons name="shield-checkmark" size={40} color={colors.themeColor} />
            {allRequiredGranted ? (
              <View style={[styles.heroCheck, { backgroundColor: colors.themeColor, borderColor: colors.background }]}>
                <Ionicons name="checkmark" size={14} color="#ffffff" />
              </View>
            ) : null}
          </View>

          <Text style={[styles.heroTitle, { color: colors.primaryTextColor }]}>
            Allow All Permissions
          </Text>
          <Text style={[styles.heroSubtitle, { color: colors.secondaryTextColor }]}>
            {APP_TAG_NAME || 'This app'} needs the following permissions to give you the best
            messaging experience. You stay in control — you can change any of them later in
            Settings.
          </Text>
        </View>

        {/* ── Permanently denied guidance ─────────────────────────────────────── */}
        {blockedItems.length > 0 ? (
          <View
            style={[
              styles.noticeCard,
              {
                backgroundColor: withAlpha(colors.danger, isDarkMode ? 0.16 : 0.08),
                borderColor: withAlpha(colors.danger, 0.35),
              },
            ]}
          >
            <Ionicons name="information-circle" size={20} color={colors.danger} />
            <View style={styles.noticeCopy}>
              <Text style={[styles.noticeTitle, { color: colors.primaryTextColor }]}>
                {blockedItems.length === 1
                  ? `${blockedItems[0].title} is turned off`
                  : 'Some permissions are turned off'}
              </Text>
              <Text style={[styles.noticeText, { color: colors.secondaryTextColor }]}>
                Your device will not show the permission prompt again. Open Settings to turn
                {blockedItems.length === 1 ? ' it ' : ' them '}
                on, then come back — this screen updates automatically.
              </Text>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={openSettings}
                style={[styles.noticeButton, { backgroundColor: colors.danger }]}
                accessibilityRole="button"
              >
                <Ionicons name="settings-outline" size={15} color="#ffffff" />
                <Text style={styles.noticeButtonText}>Open Settings</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* ── Permission list ─────────────────────────────────────────────────── */}
        {isLoading ? (
          <View style={styles.loader}>
            <ActivityIndicator size="small" color={colors.themeColor} />
          </View>
        ) : (
          items.map((item) => (
            <PermissionListItem
              key={item.id}
              item={item}
              onAllow={handleAllow}
              onOpenSettings={openSettings}
            />
          ))
        )}
      </ScrollView>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <View style={[styles.footer, { borderTopColor: colors.borderColor, backgroundColor: colors.background }]}>
        <TouchableOpacity
          activeOpacity={0.85}
          disabled={!continueEnabled}
          onPress={handleContinue}
          style={[
            styles.continueButton,
            { backgroundColor: continueEnabled ? colors.themeColor : colors.borderColor },
          ]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !continueEnabled }}
          accessibilityLabel="Continue"
        >
          <Text
            style={[
              styles.continueText,
              { color: continueEnabled ? colors.textWhite : colors.placeHolderTextColor },
            ]}
          >
            Continue
          </Text>
        </TouchableOpacity>

        <Text style={[styles.footerHint, { color: colors.secondaryTextColor }]}>
          {allRequiredGranted
            ? "You're all set — tap Continue to get started."
            : `Please allow ${pendingCount === 1 ? 'the remaining permission' : 'all permissions'} to continue.`}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24,
  },
  hero: {
    alignItems: 'center',
    marginBottom: 26,
  },
  heroBadge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  heroCheck: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 23,
    textAlign: 'center',
  },
  heroSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13.5,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 4,
  },
  noticeCard: {
    flexDirection: 'row',
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 14,
  },
  noticeCopy: {
    flex: 1,
    paddingLeft: 10,
  },
  noticeTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
  },
  noticeText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 3,
  },
  noticeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 9,
    marginTop: 12,
  },
  noticeButtonText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 13,
    color: '#ffffff',
  },
  loader: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  continueButton: {
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
  },
  footerHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
});
