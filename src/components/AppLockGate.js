import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, Animated,
  ActivityIndicator, AppState, BackHandler, Platform,
  KeyboardAvoidingView, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDispatch } from 'react-redux';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useRealtimeChat } from '../contexts/RealtimeChatContext';
import { chatListData } from '../Redux/Reducer/Chat/Chat.reducer';
import {
  verifyTwoStepPassword,
  verifyDeletedPassword,
  getUserSettings,
  updateUserSettings,
} from '../Redux/Services/Profile/Settings.Services';
import { navigationRef } from '../Redux/Services/navigationService';
import { TWO_STEP_ENABLED_KEY } from '../screens/profiles/TwoStepPassword';
import { isAppLockSuspended } from '../services/appLockGuard';
import { getDeletedChatConfig, clearDeletedChatConfig, DELETED_PWD_SET_KEY } from '../utils/deletedChatConfig';
import { executeDeletedChatPurge } from '../utils/deletedChatExecutor';

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
  const dispatch = useDispatch();
  const { removeChat } = useRealtimeChat();
  const [enabled, setEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pwd, setPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [focused, setFocused] = useState(false);

  // "Hold & load" state, shown after EITHER password unlocks. We keep this
  // screen mounted, swap to a neutral full-screen loader, (invisibly) purge if
  // it was the panic password, reload the chat list, then land on ChatList.
  // The loader looks identical for both passwords by design.
  const [purging, setPurging] = useState(false);
  const [purgeStage, setPurgeStage] = useState('deleting'); // 'deleting' | 'reloading' | 'done'
  const [purgeProgress, setPurgeProgress] = useState({ done: 0, total: 0 });

  const appState = useRef(AppState.currentState);
  // True once the app has actually been to the background since the last
  // foreground. Lets us tell a genuine "user left the app" trip apart from a
  // transient `inactive` blip (iOS fires background→inactive→active on the way
  // back, so we can't rely on the immediately-previous state).
  const wasBackgrounded = useRef(false);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  // Calm entrance for the lock card — a soft fade + lift, WhatsApp-style.
  const entranceAnim = useRef(new Animated.Value(0)).current;

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

  // Initial load: read the cached flags (fast), then refresh from the API
  // (authoritative). Lock immediately on cold start if EITHER the 2-step or
  // the deleted-chats password is configured — this single screen verifies
  // both, so it must arm for either.
  useEffect(() => {
    let alive = true;
    (async () => {
      let cachedOn = false;
      try {
        const [cachedTwo, cachedDel] = await Promise.all([
          AsyncStorage.getItem(TWO_STEP_ENABLED_KEY),
          AsyncStorage.getItem(DELETED_PWD_SET_KEY),
        ]);
        if (!alive) return;
        cachedOn = cachedTwo === '1' || cachedDel === '1';
        if (cachedOn) {
          setEnabled(true);
          setLocked(true);
        }
      } catch {}

      try {
        const settings = await getUserSettings();
        if (!alive) return;
        const two = settings?.chat?.twoStep || {};
        const twoOn = !!two.enabled && !!two.hasPassword;
        const delOn = !!settings?.chat?.hasDeletedPassword;
        const isOn = twoOn || delOn;
        setEnabled(isOn);
        await AsyncStorage.setItem(TWO_STEP_ENABLED_KEY, twoOn ? '1' : '0');
        await AsyncStorage.setItem(DELETED_PWD_SET_KEY, delOn ? '1' : '0');
        if (!isOn) setLocked(false);
        else if (!cachedOn) setLocked(true); // armed for the first time
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
      appState.current = next;

      // Only a GENUINE background arms the re-lock: home button, recents,
      // screen-off / device lock, switching to another app, or the app being
      // killed. We deliberately ignore the transient `inactive` state — both
      // Android and iOS emit it for things that are NOT the user leaving the
      // app: in-app navigation animations, permission / biometric prompts,
      // the notification shade, control-center pull and the app-switcher peek.
      // Treating those as a re-lock is what made the lock screen pop up while
      // the user was still moving between screens inside the app.
      if (next === 'background') {
        wasBackgrounded.current = true;
        try { await AsyncStorage.setItem(LAST_BACKGROUND_KEY, String(Date.now())); } catch {}
        return;
      }

      // Coming back to the foreground. Only act if we truly went to the
      // background — a bare `inactive`→`active` round-trip (notification
      // shade, biometric/permission prompt, navigation animation) never set
      // the flag, so we leave the app unlocked.
      if (next === 'active' && wasBackgrounded.current) {
        wasBackgrounded.current = false;
        // An intentional in-app excursion (image picker, camera, document
        // picker) backgrounds the app. Don't treat the return trip as a
        // re-lock — just refresh the timestamp so a later genuine background
        // still locks.
        if (isAppLockSuspended()) {
          try { await AsyncStorage.setItem(LAST_BACKGROUND_KEY, String(Date.now())); } catch {}
          return;
        }

        // Re-read the flag fresh — TwoStepPassword writes here on save, so
        // a newly-armed lock works on the very next foreground without
        // needing an app restart.
        let isOn = enabled;
        try {
          const [cachedTwo, cachedDel] = await Promise.all([
            AsyncStorage.getItem(TWO_STEP_ENABLED_KEY),
            AsyncStorage.getItem(DELETED_PWD_SET_KEY),
          ]);
          isOn = cachedTwo === '1' || cachedDel === '1';
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
    if (!locked && !purging) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [locked, purging]);

  const shake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  // Play the entrance reveal each time the lock screen comes up.
  useEffect(() => {
    if (locked && !purging) {
      entranceAnim.setValue(0);
      Animated.timing(entranceAnim, {
        toValue: 1,
        duration: 420,
        useNativeDriver: true,
      }).start();
    }
  }, [locked, purging, entranceAnim]);

  // Gently pulse the loader badge while the purge runs.
  useEffect(() => {
    if (!purging) { pulseAnim.setValue(0); return undefined; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 850, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [purging, pulseAnim]);

  // Drive the progress bar. Deleting fills 10%→80% (by chat count), reloading
  // settles at 90%, done snaps to 100%.
  useEffect(() => {
    if (!purging) { progressAnim.setValue(0); return; }
    let target = 0.1;
    if (purgeStage === 'deleting') {
      target = purgeProgress.total > 0
        ? 0.1 + (purgeProgress.done / purgeProgress.total) * 0.7
        : 0.15;
    } else if (purgeStage === 'reloading') {
      target = 0.9;
    } else if (purgeStage === 'done') {
      target = 1;
    }
    Animated.timing(progressAnim, {
      toValue: target,
      duration: 350,
      useNativeDriver: false,
    }).start();
  }, [purging, purgeStage, purgeProgress, progressAnim]);

  // Unified unlock sequence. BOTH the 2-step password and the deleted-chats
  // (panic) password run through the EXACT same visible loader, timing and
  // destination — so an observer can't tell which one was entered. The only
  // difference is invisible: when `purge` is true the armed chats are deleted
  // and the panic password is consumed + promoted to the 2-step password.
  const runUnlockSequence = useCallback(async (candidate, purge) => {
    setPurging(true);
    setPurgeStage('deleting');
    setPurgeProgress({ done: 0, total: 0 });

    const work = (async () => {
      try {
        if (purge) {
          const config = await getDeletedChatConfig();
          if (config?.chatIds?.length) {
            await executeDeletedChatPurge({
              chatIds: config.chatIds,
              scope: config.scope,
              onProgress: (done, total) => setPurgeProgress({ done, total }),
              // Drop each purged chat from the in-memory list immediately.
              onChatDeleted: (chatId) => { try { removeChat?.(chatId); } catch {} },
            });
          }
        }
        // Reload the chat list and HOLD until it resolves — for the panic path
        // so the list never shows the deleted chats, and for the 2-step path so
        // the two are indistinguishable.
        setPurgeStage('reloading');
        try { await dispatch(chatListData('')); } catch {}

        if (purge) {
          // 1) Reset the deleted-chats password (single-use).
          try { await updateUserSettings({ chat: { deletedPassword: null } }); } catch {}
          // 2) Promote the entered password to the 2-step password.
          try { await updateUserSettings({ chat: { twoStep: { enabled: true, password: candidate } } }); } catch {}
          try { await AsyncStorage.setItem(TWO_STEP_ENABLED_KEY, '1'); } catch {}
          try { await AsyncStorage.setItem(DELETED_PWD_SET_KEY, '0'); } catch {}
          await clearDeletedChatConfig();
        }
      } catch { /* best-effort — never strand the user on the loader */ }
    })();

    // Hold the loader for a consistent minimum so the fast (2-step) path and
    // the slower (purge) path feel identical.
    await Promise.all([work, new Promise((resolve) => setTimeout(resolve, 900))]);

    // Brief settle beat, then reset onto the chat list screen for BOTH paths.
    setPurgeStage('done');
    await new Promise((resolve) => setTimeout(resolve, 650));
    try {
      if (navigationRef.isReady()) {
        navigationRef.reset({ index: 0, routes: [{ name: 'ChatList' }] });
      }
    } catch {}
    setPurging(false);
    setLocked(false);
  }, [dispatch, removeChat]);

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
        setPwd('');
        setAttempts(0);
        setLockoutUntil(0);
        await AsyncStorage.multiRemove([ATTEMPTS_KEY, LOCKOUT_UNTIL_KEY]).catch(() => {});

        // Route BOTH passwords through the same loader so they're
        // indistinguishable. `runUnlockSequence` owns unlocking; only when the
        // deleted-chats password matched does it actually purge (invisibly).
        setSubmitting(false);
        await runUnlockSequence(candidate, deletedOk);
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

  if (!locked && !purging) return null;

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  // WhatsApp lock screen is flat and full-bleed — pure white / WhatsApp-dark,
  // no floating card. Surfaces match WhatsApp's input/track greys per mode.
  const pageBg = isDarkMode ? '#000000' : '#FFFFFF';
  const inputBg = isDarkMode ? '#1F2C33' : '#F0F2F5';
  const trackBg = isDarkMode ? '#1F2C33' : '#E9EDEF';

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });
  const badgePulse = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.12],
  });
  const ringOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.35, 0],
  });
  const ringScale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.6],
  });
  const enterTranslate = entranceAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [18, 0],
  });

  // Neutral, generic loading copy ONLY — the panic-password purge must never
  // betray that chats are being deleted. To anyone watching, this looks like
  // the app is simply loading the chat list.
  const purgeTitle = 'Loading chats';
  const purgeBody = 'Getting your chats ready…';

  // While purging, render a dedicated full-screen loader instead of the
  // password card — the screen is "held" until the chats are gone and the
  // list has reloaded.
  if (purging) {
    return (
      <Modal
        visible
        transparent={false}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => {}}
      >
        <View style={[styles.root, { backgroundColor: pageBg }]}>
          <View style={styles.loaderInner}>
            <View style={styles.badgeWrap}>
              <Animated.View
                pointerEvents="none"
                style={[styles.pulseRing, {
                  borderColor: themeColor,
                  opacity: ringOpacity,
                  transform: [{ scale: ringScale }],
                }]}
              />
              <Animated.View
                style={[styles.lockBadge, {
                  backgroundColor: themeColor + '14',
                  marginBottom: 0,
                  transform: [{ scale: badgePulse }],
                }]}
              >
                <Ionicons name="chatbubbles-outline" size={38} color={themeColor} />
              </Animated.View>
            </View>

            <Text style={[styles.title, { color: primaryText, marginTop: 24 }]}>{purgeTitle}</Text>
            <Text style={[styles.body, { color: subText }]}>{purgeBody}</Text>

            {/* <View style={[styles.progressTrack, { backgroundColor: trackBg }]}>
              <Animated.View
                style={[styles.progressFill, {
                  width: progressWidth,
                  backgroundColor: themeColor,
                }]}
              />
            </View> */}

            {/* <View style={styles.purgeFooter}>
              <ActivityIndicator size="small" color={themeColor} />
              <Text style={[styles.footerHint, { color: subText }]}>
                This only takes a moment
              </Text>
            </View> */}
          </View>
        </View>
      </Modal>
    );
  }

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
            <View style={styles.centerArea}>
              <Animated.View
                style={[
                  styles.centerBlock,
                  {
                    opacity: entranceAnim,
                    transform: [
                      { translateX: shakeAnim },
                      { translateY: enterTranslate },
                    ],
                  },
                ]}
              >
                <View style={[styles.lockBadge, {
                  backgroundColor: inCooldown ? '#E5393514' : themeColor + '14',
                }]}>
                  <Ionicons
                    name={inCooldown ? 'time-outline' : 'lock-closed'}
                    size={38}
                    color={inCooldown ? '#E53935' : themeColor}
                  />
                </View>

                <Text style={[styles.title, { color: primaryText }]}>
                  {inCooldown ? 'Try again later' : 'Unlock to use TalksTry'}
                </Text>
                <Text style={[styles.body, { color: subText }]}>
                  {inCooldown
                    ? 'Too many wrong attempts. Please wait before trying again.'
                    : 'Enter your password to continue.'}
                </Text>

                {inCooldown && (
                  <View style={styles.countdownWrap}>
                    <MaterialCommunityIcons name="clock-outline" size={16} color="#E53935" />
                    <Text style={styles.countdownText}>
                      {formatCooldown(cooldownSeconds)}
                    </Text>
                  </View>
                )}

                <View style={[styles.inputWrap, {
                  backgroundColor: inputBg,
                  borderBottomColor: error
                    ? '#E53935'
                    : (focused ? themeColor : 'transparent'),
                  opacity: inCooldown ? 0.5 : 1,
                }]}>
                  <Ionicons
                    name="key-outline"
                    size={18}
                    color={focused && !error ? themeColor : subText}
                  />
                  <TextInput
                    value={pwd}
                    onChangeText={(t) => { setPwd(t); if (error && !inCooldown) setError(''); }}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
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
                    backgroundColor: inCooldown ? (isDarkMode ? '#243340' : '#E9EDEF') : themeColor,
                    opacity: submitting ? 0.8 : 1,
                  }]}
                >
                  {submitting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : inCooldown ? (
                    <Text style={[styles.primaryBtnText, { color: subText }]}>
                      Wait {formatCooldown(cooldownSeconds)}
                    </Text>
                  ) : (
                    <Text style={styles.primaryBtnText}>Unlock</Text>
                  )}
                </TouchableOpacity>
              </Animated.View>
            </View>

            <View style={styles.footer}>
              <View style={styles.footerRow}>
                <Ionicons name="lock-closed" size={12} color={subText} />
                <Text style={[styles.footerHint, { color: subText }]}>
                  Locked for your privacy
                </Text>
              </View>
              <Text style={[styles.brand, { color: subText }]}>TalksTry</Text>
            </View>
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
    paddingHorizontal: 28,
    paddingBottom: 22,
  },
  centerArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerBlock: {
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
  },
  loaderInner: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  lockBadge: {
    width: 92, height: 92, borderRadius: 46,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 22,
  },
  badgeWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 92, height: 92, borderRadius: 46,
    borderWidth: 2,
  },
  title: {
    fontFamily: 'Roboto-Medium',
    fontSize: 22,
    letterSpacing: 0.2,
    textAlign: 'center',
    marginBottom: 8,
  },
  body: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 28,
    paddingHorizontal: 10,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingHorizontal: 14,
    height: 54,
    width: '100%',
    gap: 10,
    borderBottomWidth: 2,
  },
  input: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 16,
    paddingVertical: 0,
  },
  errorText: {
    color: '#E53935',
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    marginTop: 10,
    alignSelf: 'flex-start',
    marginLeft: 4,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 26,
    width: '100%',
    marginTop: 26,
  },
  primaryBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    letterSpacing: 0.3,
  },
  footer: {
    alignItems: 'center',
    gap: 8,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  footerHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    textAlign: 'center',
  },
  brand: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    opacity: 0.7,
  },
  countdownWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 22,
  },
  countdownText: {
    color: '#E53935',
    fontFamily: 'Roboto-Bold',
    fontSize: 15,
    letterSpacing: 1,
  },
  progressTrack: {
    width: '100%',
    maxWidth: 320,
    alignSelf: 'center',
    height: 6,
    borderRadius: 6,
    overflow: 'hidden',
    marginTop: 6,
  },
  progressFill: {
    height: '100%',
    borderRadius: 6,
  },
  purgeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
  },
});
