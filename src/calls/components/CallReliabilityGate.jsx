import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, AppState, Platform, DeviceEventEmitter, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import {
  requestDisableBatteryOptimization, openAutoStartSettings, openFullScreenIntentSettings,
} from '../../../modules/expo-call-ui';
import {
  evaluateReliability, getReliabilityIssues, snoozeReliability, dismissReliabilityForever,
  clearReliabilityFlags, RELIABILITY_OPEN_EVENT, maybeAutoRequestBackground,
  acknowledgeAutoStart,
} from '../services/callReliability';

/**
 * One-time onboarding that keeps calls ringing when the app is closed / after a
 * device restart. On OEM skins (MIUI, FuntouchOS, ColorOS, …) a killed app is
 * blocked from waking on the incoming-call FCM push unless the user exempts it
 * from battery optimization AND enables OEM Autostart — this card jumps straight
 * to both toggles. Self-contained: mount it once (CallProvider) with no wiring.
 *
 * Shows only when: Android + signed in + at least one reliability problem (see
 * callReliabilityPolicy: notifications off, calls channel off, Android 14+
 * full-screen intent denied, battery exemption missing, known-OEM Autostart not
 * yet pointed at) + not snoozed / permanently dismissed. Re-checks whenever the
 * app returns to the foreground (e.g. right after the user fixes a setting).
 */
export default function CallReliabilityGate() {
  const { isAuthenticated } = useAuth();
  const { theme, isDarkMode } = useTheme();
  const c = theme?.colors || {};
  const [visible, setVisible] = useState(false);
  const [issues, setIssues] = useState([]);
  const evaluatingRef = useRef(false);

  const evaluate = useCallback(async () => {
    if (Platform.OS !== 'android' || !isAuthenticated) return;
    if (evaluatingRef.current) return;
    evaluatingRef.current = true;
    try {
      const { offer, issues: found } = await evaluateReliability();
      setIssues(found);
      if (offer) {
        // First entry with ONLY the battery exemption missing: fire the OS's own
        // "allow background activity" dialog directly instead of our onboarding
        // card - the user grants it in one tap with no in-app interruption. Any
        // other problem (notifications, full-screen, Autostart) needs the card,
        // which also lists the battery row. Settings can always open it manually.
        const onlyBattery = found.length === 1 && found[0] === 'battery';
        const systemDialogFired = onlyBattery ? await maybeAutoRequestBackground() : false;
        setVisible(!systemDialogFired);
      } else {
        setVisible(false);
        // Clean slate only when EVERYTHING is fixed; clearing snooze while another
        // problem remains would make the card nag again at once.
        if (found.length === 0) clearReliabilityFlags();
      }
    } finally {
      evaluatingRef.current = false;
    }
  }, [isAuthenticated]);

  // Evaluate shortly after login and whenever the app comes back to the
  // foreground (covers the user returning from the battery / autostart settings).
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    let mounted = true;
    const t = setTimeout(() => { if (mounted) evaluate(); }, 1500);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') evaluate();
    });
    return () => { mounted = false; clearTimeout(t); sub.remove(); };
  }, [evaluate]);

  // Manual open from Settings — always shows (ignores snooze / "don't show again").
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(RELIABILITY_OPEN_EVENT, async () => {
      try { setIssues(await getReliabilityIssues()); } catch (_) { /* no-op */ }
      setVisible(true);
    });
    return () => sub.remove();
  }, []);

  const onAllowBackground = useCallback(() => {
    requestDisableBatteryOptimization();
    // The system dialog backgrounds us; the AppState 'active' listener re-checks
    // on return and auto-closes if the exemption was granted.
  }, []);

  const onOpenAutostart = useCallback(() => {
    openAutoStartSettings();
    acknowledgeAutoStart(); // pointed at it once per install (P-C-09)
  }, []);

  const onOpenNotificationSettings = useCallback(() => {
    // App notification settings (POST_NOTIFICATIONS / the calls channel live here).
    Linking.openSettings().catch(() => {});
  }, []);

  const onOpenFullScreenSettings = useCallback(() => {
    openFullScreenIntentSettings();
  }, []);

  const onLater = useCallback(async () => {
    setVisible(false);
    await snoozeReliability();
  }, []);

  const onNever = useCallback(async () => {
    setVisible(false);
    await dismissReliabilityForever();
  }, []);

  if (Platform.OS !== 'android' || !visible) return null;

  const bg = c.menuSurface || (isDarkMode ? '#202323' : '#FFFFFF');
  const text = isDarkMode ? '#FFFFFF' : (c.primaryTextColor || '#111');
  const subText = isDarkMode ? 'rgba(255,255,255,0.72)' : (c.secondaryTextColor || '#555');
  const brand = c.primary || '#03b0a2';
  const divider = isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onLater}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: bg }]}>
          <View style={[styles.iconWrap, { backgroundColor: `${brand}22` }]}>
            <Ionicons name="call" size={26} color={brand} />
          </View>
          <Text style={[styles.title, { color: text }]}>Don’t miss incoming calls</Text>
          <Text style={[styles.body, { color: subText }]}>
            {issues.includes('notifications') || issues.includes('callChannel')
              ? 'Notifications for this app are turned off, so incoming calls cannot ring. Turn them on to receive calls.'
              : 'To receive calls and notifications when the app is closed or after you restart your phone, allow the app to run in the background. On some phones you also need to turn on “Autostart”.'}
          </Text>

          {(issues.includes('notifications') || issues.includes('callChannel')) && (
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: brand }]}
              activeOpacity={0.85}
              onPress={onOpenNotificationSettings}
            >
              <Ionicons name="notifications" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>
                {issues.includes('notifications') ? 'Turn on notifications' : 'Turn on call notifications'}
              </Text>
            </TouchableOpacity>
          )}

          {issues.includes('fullScreen') && (
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: divider }]}
              activeOpacity={0.85}
              onPress={onOpenFullScreenSettings}
            >
              <Ionicons name="phone-portrait-outline" size={18} color={text} />
              <Text style={[styles.secondaryBtnText, { color: text }]}>Allow full-screen calls</Text>
            </TouchableOpacity>
          )}

          {(issues.length === 0 || issues.includes('battery')) && (
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: brand }]}
              activeOpacity={0.85}
              onPress={onAllowBackground}
            >
              <Ionicons name="battery-charging" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>Allow background activity</Text>
            </TouchableOpacity>
          )}

          {(issues.length === 0 || issues.includes('battery') || issues.includes('autostart')) && (
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: divider }]}
              activeOpacity={0.85}
              onPress={onOpenAutostart}
            >
              <Ionicons name="rocket-outline" size={18} color={text} />
              <Text style={[styles.secondaryBtnText, { color: text }]}>Open autostart settings</Text>
            </TouchableOpacity>
          )}

          <View style={styles.footer}>
            <TouchableOpacity onPress={onLater} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[styles.footerText, { color: subText }]}>Later</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onNever} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[styles.footerText, { color: subText }]}>Don’t show again</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 20,
    padding: 22,
    alignItems: 'center',
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 20,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    height: 48,
    borderRadius: 12,
    marginBottom: 10,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  secondaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 6,
  },
  footerText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
