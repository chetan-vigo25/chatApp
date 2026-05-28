import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, Animated,
  ActivityIndicator, AppState, BackHandler, Platform,
  KeyboardAvoidingView, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import {
  verifyTwoStepPassword,
  verifyDeletedPassword,
  getUserSettings,
} from '../Redux/Services/Profile/Settings.Services';
import { navigationRef } from '../Redux/Services/navigationService';
import { TWO_STEP_ENABLED_KEY } from '../screens/profiles/TwoStepPassword';

// Minimum time the app can be in the background before we re-lock. Avoids
// locking on every brief OS interruption (notification shade, control center).
const BG_RELOCK_MS = 1000;
// Session token key — the lock is also armed on every cold start by simply
// having no entry in AsyncStorage when the component mounts.
const LAST_BACKGROUND_KEY = '@chat/lastBackgroundedAt';
// 3 strikes → 60 second cooldown. Persisted so the user can't bypass by
// killing and reopening the app.
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 60 * 1000;
const ATTEMPTS_KEY = '@chat/twoStepAttempts';
const LOCKOUT_UNTIL_KEY = '@chat/twoStepLockoutUntil';

export default function AppLockGate() {
  const { theme, isDarkMode } = useTheme();
  const [enabled, setEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pwd, setPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  const appState = useRef(AppState.currentState);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const cooldownLeftMs = Math.max(0, lockoutUntil - now);
  const inCooldown = cooldownLeftMs > 0;
  const cooldownSeconds = Math.ceil(cooldownLeftMs / 1000);

  // Tick once a second while the cooldown is active so the countdown updates.
  useEffect(() => {
    if (!inCooldown) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [inCooldown]);

  // When the cooldown finishes, clear the persisted state.
  useEffect(() => {
    if (lockoutUntil && !inCooldown) {
      setAttempts(0);
      setError('');
      AsyncStorage.multiRemove([ATTEMPTS_KEY, LOCKOUT_UNTIL_KEY]).catch(() => {});
    }
  }, [inCooldown, lockoutUntil]);

  // Restore any pending lockout from a previous session.
  useEffect(() => {
    (async () => {
      try {
        const [[, rawAttempts], [, rawUntil]] = await AsyncStorage.multiGet([
          ATTEMPTS_KEY, LOCKOUT_UNTIL_KEY,
        ]);
        const a = Number(rawAttempts) || 0;
        const u = Number(rawUntil) || 0;
        if (a > 0) setAttempts(a);
        if (u > Date.now()) setLockoutUntil(u);
      } catch {}
    })();
  }, []);

  // Initial load: read the cached toggle (fast), then refresh from the API
  // (authoritative). Lock immediately on cold start if 2-step is on.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(TWO_STEP_ENABLED_KEY);
        if (!alive) return;
        if (cached === '1') {
          setEnabled(true);
          setLocked(true);
        }
      } catch {}

      try {
        const settings = await getUserSettings();
        if (!alive) return;
        const two = settings?.chat?.twoStep || {};
        const isOn = !!two.enabled && !!two.hasPassword;
        setEnabled(isOn);
        await AsyncStorage.setItem(TWO_STEP_ENABLED_KEY, isOn ? '1' : '0');
        if (!isOn) setLocked(false);
        else if (cached !== '1') setLocked(true); // armed for the first time
      } catch {
        /* offline — keep cached state */
      }
    })();
    return () => { alive = false; };
  }, []);

  // AppState wiring: re-lock when returning from the background, and record
  // a timestamp on every background transition so we can ignore brief blips.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      const prev = appState.current;
      appState.current = next;

      // Going to the background (or inactive — iOS sends this during the
      // app-switcher gesture / control-center pull / Face-ID prompt).
      // Per the spec, ANY context switch should re-lock on return, so we
      // stamp the time on inactive too.
      if (next === 'background' || next === 'inactive') {
        try { await AsyncStorage.setItem(LAST_BACKGROUND_KEY, String(Date.now())); } catch {}
        return;
      }

      // Coming back to the foreground.
      if (next === 'active' && (prev === 'background' || prev === 'inactive')) {
        // Re-read the flag fresh — TwoStepPassword writes here on save, so
        // a newly-armed lock works on the very next foreground without
        // needing an app restart.
        let isOn = enabled;
        try {
          const cached = await AsyncStorage.getItem(TWO_STEP_ENABLED_KEY);
          isOn = cached === '1';
          if (isOn !== enabled) setEnabled(isOn);
        } catch {}
        if (!isOn) return;

        try {
          const rawTs = await AsyncStorage.getItem(LAST_BACKGROUND_KEY);
          const ts = rawTs ? Number(rawTs) : 0;
          const elapsed = Date.now() - ts;
          if (elapsed >= BG_RELOCK_MS) {
            setLocked(true);
            setPwd('');
            setError('');
          }
        } catch {
          setLocked(true);
        }
      }
    });
    return () => sub.remove();
  }, [enabled]);

  // While locked, swallow the hardware back button — there's no escape
  // until the right password is entered.
  useEffect(() => {
    if (!locked) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [locked]);

  const shake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const handleSubmit = async () => {
    if (inCooldown) return;
    const candidate = pwd.trim();
    if (!candidate) {
      setError('Enter your password.');
      shake();
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // Race both verifications. The candidate may match either the
      // 2-step password (normal unlock) or the deleted-chats password
      // (unlock AND jump straight into the delete-chats flow).
      const [twoStepOk, deletedOk] = await Promise.all([
        verifyTwoStepPassword(candidate),
        verifyDeletedPassword(candidate),
      ]);

      if (twoStepOk || deletedOk) {
        setLocked(false);
        setPwd('');
        setAttempts(0);
        setLockoutUntil(0);
        await AsyncStorage.multiRemove([ATTEMPTS_KEY, LOCKOUT_UNTIL_KEY]).catch(() => {});

        // If the entered password was the deleted-chats one, override
        // whatever Splash navigated to and drop the user straight into
        // the chat-selection screen. The selector itself takes care of
        // resetting the deleted password after the action completes.
        if (deletedOk) {
          if (navigationRef.isReady?.()) {
            navigationRef.reset({
              index: 0,
              routes: [{ name: 'DeletedChatsSelector' }],
            });
          }
        }
        return;
      }

      // Wrong password — bump the counter, lock for 60s on the 3rd strike.
      const nextAttempts = attempts + 1;
      setAttempts(nextAttempts);
      setPwd('');
      shake();

      if (nextAttempts >= MAX_ATTEMPTS) {
        const until = Date.now() + LOCKOUT_MS;
        setLockoutUntil(until);
        setError(`Too many wrong attempts. Try again in 1 minute.`);
        try {
          await AsyncStorage.multiSet([
            [ATTEMPTS_KEY, String(nextAttempts)],
            [LOCKOUT_UNTIL_KEY, String(until)],
          ]);
        } catch {}
      } else {
        const remaining = MAX_ATTEMPTS - nextAttempts;
        setError(`Incorrect password. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`);
        try {
          await AsyncStorage.setItem(ATTEMPTS_KEY, String(nextAttempts));
        } catch {}
      }
    } catch {
      setError('Could not verify right now. Try again.');
      shake();
    } finally {
      setSubmitting(false);
    }
  };

  const formatCooldown = (totalSeconds) => {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  if (!locked) return null;

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = isDarkMode ? '#0B141A' : '#F4F6F9';
  const cardBg = isDarkMode ? '#16222C' : '#FFFFFF';
  const inputBg = isDarkMode ? '#0F1A21' : '#F2F4F8';

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      // statusBarTranslucent ensures we cover the status bar area too.
      statusBarTranslucent
      onRequestClose={() => {}}
    >
      <View style={[styles.root, { backgroundColor: pageBg }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <View style={styles.inner}>
            <View pointerEvents="none" style={[styles.glow, { backgroundColor: themeColor + '22' }]} />
            <View pointerEvents="none" style={[styles.glow2, { backgroundColor: themeColor + '10' }]} />

            <Animated.View
              style={[
                styles.card,
                { backgroundColor: cardBg, transform: [{ translateX: shakeAnim }] },
              ]}
            >
              <View style={[styles.badge, {
                backgroundColor: inCooldown ? '#E5393520' : themeColor + '1A',
              }]}>
                <MaterialCommunityIcons
                  name={inCooldown ? 'timer-sand' : 'shield-key'}
                  size={36}
                  color={inCooldown ? '#E53935' : themeColor}
                />
              </View>
              <Text style={[styles.title, { color: primaryText }]}>
                {inCooldown ? 'Try again later' : 'App locked'}
              </Text>
              <Text style={[styles.body, { color: subText }]}>
                {inCooldown
                  ? 'Too many wrong attempts. The app is temporarily locked.'
                  : 'Enter your 2-step verification password to continue.'}
              </Text>

              {inCooldown && (
                <View style={[styles.countdownWrap, { borderColor: '#E5393540' }]}>
                  <MaterialCommunityIcons name="clock-outline" size={18} color="#E53935" />
                  <Text style={styles.countdownText}>
                    {formatCooldown(cooldownSeconds)}
                  </Text>
                </View>
              )}

              <View style={[styles.inputWrap, {
                backgroundColor: inputBg,
                borderColor: error ? '#E5393580' : 'transparent',
                opacity: inCooldown ? 0.5 : 1,
              }]}>
                <Ionicons name="key-outline" size={18} color={subText} />
                <TextInput
                  value={pwd}
                  onChangeText={(t) => { setPwd(t); if (error && !inCooldown) setError(''); }}
                  placeholder={inCooldown ? 'Locked' : 'Password'}
                  placeholderTextColor={subText}
                  secureTextEntry={!showPwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus={!inCooldown}
                  editable={!submitting && !inCooldown}
                  onSubmitEditing={handleSubmit}
                  returnKeyType="done"
                  style={[styles.input, { color: primaryText }]}
                />
                <TouchableOpacity
                  onPress={() => setShowPwd((s) => !s)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  disabled={inCooldown}
                >
                  <Ionicons
                    name={showPwd ? 'eye-off-outline' : 'eye-outline'}
                    size={20} color={subText}
                  />
                </TouchableOpacity>
              </View>

              {!!error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                activeOpacity={0.85}
                onPress={handleSubmit}
                disabled={submitting || inCooldown}
                style={[styles.primaryBtn, {
                  backgroundColor: inCooldown ? (isDarkMode ? '#243340' : '#D5DAE2') : themeColor,
                  opacity: submitting ? 0.7 : 1,
                }]}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : inCooldown ? (
                  <>
                    <Ionicons name="time-outline" size={18} color={subText} />
                    <Text style={[styles.primaryBtnText, { color: subText }]}>
                      Wait {formatCooldown(cooldownSeconds)}
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="lock-open-outline" size={18} color="#fff" />
                    <Text style={styles.primaryBtnText}>Unlock</Text>
                  </>
                )}
              </TouchableOpacity>

              <Text style={[styles.footerHint, { color: subText }]}>
                Wrong password? The app stays locked. There's no skip here.
              </Text>
            </Animated.View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  inner: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    position: 'relative',
  },
  glow: {
    position: 'absolute',
    top: '15%', right: -60,
    width: 240, height: 240, borderRadius: 120,
  },
  glow2: {
    position: 'absolute',
    bottom: '15%', left: -50,
    width: 200, height: 200, borderRadius: 100,
  },
  card: {
    borderRadius: 24,
    padding: 26,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 16 },
    shadowRadius: 28,
    elevation: 6,
  },
  badge: {
    width: 76, height: 76, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    fontFamily: 'Roboto-Bold',
    fontSize: 22,
    marginBottom: 8,
  },
  body: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 22,
    paddingHorizontal: 6,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 52,
    width: '100%',
    gap: 10,
    borderWidth: 1.5,
  },
  input: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 15,
    paddingVertical: 0,
  },
  errorText: {
    color: '#E53935',
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 8,
    alignSelf: 'flex-start',
    marginLeft: 4,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: 14,
    width: '100%',
    marginTop: 18,
  },
  primaryBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },
  footerHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 14,
  },
  countdownWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 18,
  },
  countdownText: {
    color: '#E53935',
    fontFamily: 'Roboto-Bold',
    fontSize: 16,
    letterSpacing: 1,
  },
});
