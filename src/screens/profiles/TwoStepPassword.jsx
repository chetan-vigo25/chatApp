import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Animated, StyleSheet,
  TextInput, ActivityIndicator, Alert, Switch,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome6, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import {
  getUserSettings,
  updateUserSettings,
} from '../../Redux/Services/Profile/Settings.Services';
import {
  clearDeletedChatConfig,
  markDeletedPasswordSet,
} from '../../utils/deletedChatConfig';

// AsyncStorage key the top-level AppLockGate reads to decide whether to
// re-lock on app foreground. Keep in sync with AppLockGate.js.
export const TWO_STEP_ENABLED_KEY = '@chat/twoStepEnabled';

export default function TwoStepPassword({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;

  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  // Mirrors whether a deleted-chats password is currently set. That password
  // depends on this 2-step password (the panic flow promotes the entered
  // password into the 2-step password), so clearing 2-step must also clear it.
  const [hasDeletedPassword, setHasDeletedPassword] = useState(false);
  const [pwd, setPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();

    let alive = true;
    (async () => {
      try {
        const settings = await getUserSettings();
        if (!alive) return;
        const chat = settings?.chat || {};
        const two = chat.twoStep || {};
        setEnabled(!!two.enabled);
        setHasPassword(!!two.hasPassword);
        setHasDeletedPassword(
          typeof chat.hasDeletedPassword === 'boolean'
            ? chat.hasDeletedPassword
            : !!chat.deletedPassword
        );
        // Mirror state into AsyncStorage so AppLockGate reads the freshest value
        // on next app launch even before the API call resolves.
        await AsyncStorage.setItem(TWO_STEP_ENABLED_KEY, two.enabled ? '1' : '0');
      } catch {
        /* leave defaults */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const inputBg = isDarkMode ? '#0F1A21' : '#F2F4F8';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(15,30,50,0.06)';

  const clearMessages = () => {
    if (error) setError('');
    if (success) setSuccess('');
  };

  // Clearing the 2-step password orphans the deleted-chats password (it relies
  // on this password to arm the panic flow). So whenever 2-step is reset or
  // disabled, also clear a previously-set deleted-chats password + its local
  // armed selection. No-op when no deleted-chats password was set.
  const clearDeletedPasswordIfSet = async () => {
    if (!hasDeletedPassword) return;
    try {
      await updateUserSettings({ chat: { deletedPassword: null } });
      await clearDeletedChatConfig();
      await markDeletedPasswordSet(false);
      setHasDeletedPassword(false);
    } catch {
      /* best-effort — don't block the 2-step reset on this */
    }
  };

  // Toggle handler — flipping ON without a password just stages the intent;
  // the user still has to set a password below to actually arm the lock.
  // Flipping OFF immediately calls the API and clears the password.
  const handleToggle = async (next) => {
    clearMessages();
    if (next === enabled) return;

    if (!next) {
      // Disable: confirm and clear server-side
      Alert.alert(
        'Disable app lock?',
        'You will no longer be asked for a password when reopening the app.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disable',
            style: 'destructive',
            onPress: async () => {
              setBusy(true);
              try {
                await updateUserSettings({
                  chat: { twoStep: { enabled: false, password: null } },
                });
                // Disabling 2-step orphans the deleted-chats password — clear it too.
                await clearDeletedPasswordIfSet();
                setEnabled(false);
                setHasPassword(false);
                await AsyncStorage.setItem(TWO_STEP_ENABLED_KEY, '0');
                setSuccess('App lock disabled.');
              } catch (e) {
                setError(typeof e === 'string' ? e : 'Could not disable. Try again.');
              } finally {
                setBusy(false);
              }
            },
          },
        ]
      );
      return;
    }

    // Enabling: locally flag it. We don't call the API until the user
    // saves a valid password — `enabled: true` without a password is a
    // useless state and we'd rather not persist it.
    setEnabled(true);
  };

  const handleSave = async () => {
    clearMessages();
    if (!enabled) {
      setError('Turn on the app lock toggle first.');
      return;
    }
    const trimmed = pwd.trim();
    if (trimmed.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (trimmed.length > 128) {
      setError('Password is too long (max 128 chars).');
      return;
    }
    if (trimmed !== confirmPwd.trim()) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await updateUserSettings({
        chat: { twoStep: { enabled: true, password: trimmed } },
      });
      setHasPassword(true);
      setPwd('');
      setConfirmPwd('');
      await AsyncStorage.setItem(TWO_STEP_ENABLED_KEY, '1');
      setSuccess(hasPassword ? 'Password updated.' : 'App lock password set.');
    } catch (e) {
      // Surface the server message (e.g. "This password is already in use as
      // your deleted-chats password.") — the rejected error is an object, not a
      // plain string, so the previous typeof check always fell back to generic.
      const msg = typeof e === 'string'
        ? e
        : (e?.message || e?.data?.message || 'Could not save password. Try again.');
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    if (!hasPassword) return;
    Alert.alert(
      'Reset password?',
      hasDeletedPassword
        ? 'Your app lock password will be cleared and app lock will be TURNED OFF so you can keep using the app. Your chat delete password depends on it, so it will be cleared too. You can re-enable app lock and set new passwords afterwards.'
        : 'Your app lock password will be cleared and app lock will be TURNED OFF so you can keep using the app. You can re-enable it and set a new password afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            clearMessages();
            setBusy(true);
            const deletedWasSet = hasDeletedPassword;
            try {
              // Reset is the RECOVERY path (e.g. forgotten password): clear the
              // password AND disable app lock, so the user isn't locked out on the
              // next launch/foreground and can use the app right away.
              await updateUserSettings({
                chat: { twoStep: { enabled: false, password: null } },
              });
              // Reset the deleted-chats password too — it depended on this one.
              await clearDeletedPasswordIfSet();
              setEnabled(false);
              setHasPassword(false);
              setPwd('');
              setConfirmPwd('');
              await AsyncStorage.setItem(TWO_STEP_ENABLED_KEY, '0');
              setSuccess(
                deletedWasSet
                  ? 'Password reset and app lock turned off. Your chat delete password was also cleared. Re-enable app lock to set a new one.'
                  : 'Password reset and app lock turned off. Re-enable app lock anytime to set a new password.'
              );
            } catch (e) {
              setError(typeof e === 'string' ? e : 'Could not reset password.');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  // The Update/Set button stays DISABLED until both fields hold a valid, matching
  // password (4–128 chars) and the lock is on — same rules handleSave enforces.
  const trimmedNewPwd = pwd.trim();
  const isPasswordFormValid =
    enabled &&
    trimmedNewPwd.length >= 4 &&
    trimmedNewPwd.length <= 128 &&
    trimmedNewPwd === confirmPwd.trim();

  // ─── Header ───
  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={() => navigation.goBack()}
        activeOpacity={0.6}
        style={[styles.headerBackBtn, { backgroundColor: cardBg }]}
      >
        <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
      </TouchableOpacity>
      <View style={styles.flex}>
        <Text style={[styles.headerTitle, { color: primaryText }]}>
          App lock password
        </Text>
        <Text style={[styles.headerSubtitle, { color: subText }]}>
          {loading
            ? 'Loading…'
            : enabled
            ? (hasPassword ? 'Active' : 'Enabled · password required')
            : 'Off'}
        </Text>
      </View>
    </View>
  );

  // ─── Hero ───
  const renderHero = () => (
    <Animated.View
      style={[
        styles.heroWrap,
        { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
      ]}
    >
      <View pointerEvents="none" style={[styles.heroHalo, { backgroundColor: themeColor + '22' }]} />
      <View pointerEvents="none" style={[styles.heroHalo2, { backgroundColor: themeColor + '10' }]} />
      <View style={[styles.heroCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        <View style={[styles.heroBadge, { backgroundColor: themeColor + '1A' }]}>
          <MaterialCommunityIcons name="shield-key" size={26} color={themeColor} />
        </View>
        <Text style={[styles.heroTitle, { color: primaryText }]}>
          Lock your chats with a password
        </Text>
        <Text style={[styles.heroBody, { color: subText }]}>
          When enabled, you'll be asked for this password every time the app
          launches or returns from the background. Different from your
          chat delete password.
        </Text>
      </View>
    </Animated.View>
  );

  // ─── Toggle ───
  const renderToggle = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>STATUS</Text>
      <View style={[styles.sectionCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        <View style={styles.toggleRow}>
          <View style={[styles.toggleIconWrap, {
            backgroundColor: enabled ? '#00B89420' : (isDarkMode ? '#243340' : '#F2F4F8'),
          }]}>
            <Ionicons
              name={enabled ? 'shield-checkmark' : 'shield-outline'}
              size={20}
              color={enabled ? '#00B894' : subText}
            />
          </View>
          <View style={styles.flex}>
            <Text style={[styles.toggleLabel, { color: primaryText }]}>
              Enable app lock
            </Text>
            <Text style={[styles.toggleSub, { color: subText }]}>
              {enabled
                ? (hasPassword ? 'Password is active' : 'Set a password to arm it')
                : 'Off'}
            </Text>
          </View>
          {busy ? (
            <ActivityIndicator size="small" color={themeColor} />
          ) : (
            <Switch
              value={enabled}
              onValueChange={handleToggle}
              disabled={loading || submitting}
              trackColor={{ false: isDarkMode ? '#3A4A56' : '#D5DAE2', true: themeColor + '80' }}
              thumbColor={enabled ? themeColor : '#fff'}
              ios_backgroundColor={isDarkMode ? '#3A4A56' : '#D5DAE2'}
            />
          )}
        </View>
      </View>
    </View>
  );

  // ─── Password form (only when toggle is on) ───
  const renderForm = () => {
    if (!enabled) return null;
    return (
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: subText }]}>
          {hasPassword ? 'UPDATE PASSWORD' : 'SET PASSWORD'}
        </Text>
        <View style={[styles.formCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
          <View style={[styles.inputWrap, { backgroundColor: inputBg }]}>
            <Ionicons name="key-outline" size={18} color={subText} />
            <TextInput
              value={pwd}
              onChangeText={(t) => { setPwd(t); clearMessages(); }}
              placeholder={hasPassword ? 'New password' : 'Password'}
              placeholderTextColor={subText}
              secureTextEntry={!showPwd}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting && !busy}
              style={[styles.input, { color: primaryText }]}
            />
            <TouchableOpacity
              onPress={() => setShowPwd((s) => !s)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons
                name={showPwd ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={subText}
              />
            </TouchableOpacity>
          </View>

          <View style={[styles.inputWrap, { backgroundColor: inputBg }]}>
            <Ionicons name="checkmark-circle-outline" size={18} color={subText} />
            <TextInput
              value={confirmPwd}
              onChangeText={(t) => { setConfirmPwd(t); clearMessages(); }}
              placeholder="Confirm password"
              placeholderTextColor={subText}
              secureTextEntry={!showPwd}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting && !busy}
              style={[styles.input, { color: primaryText }]}
            />
          </View>

          {!!error && (
            <View style={styles.msgRow}>
              <Ionicons name="alert-circle" size={14} color="#E53935" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          {!!success && (
            <View style={styles.msgRow}>
              <Ionicons name="checkmark-circle" size={14} color="#00B894" />
              <Text style={styles.successText}>{success}</Text>
            </View>
          )}

          <TouchableOpacity
            activeOpacity={0.85}
            onPress={handleSave}
            disabled={!isPasswordFormValid || submitting || busy || loading}
            style={[styles.primaryBtn, {
              backgroundColor: themeColor,
              opacity: (!isPasswordFormValid || submitting || busy || loading) ? 0.5 : 1,
            }]}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="save-outline" size={18} color="#fff" />
                <Text style={styles.primaryBtnText}>
                  {hasPassword ? 'Update password' : 'Set password'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Reset ───
  const renderReset = () => {
    if (!enabled) return null;
    return (
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: subText }]}>RECOVERY</Text>
        <View style={[styles.sectionCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleReset}
            disabled={!hasPassword || busy || submitting}
            style={styles.row}
          >
            <View style={[styles.rowIconWrap, {
              backgroundColor: hasPassword ? '#E5393520' : (isDarkMode ? '#243340' : '#F2F4F8'),
            }]}>
              <MaterialCommunityIcons
                name="lock-reset"
                size={22}
                color={hasPassword ? '#E53935' : subText}
              />
            </View>
            <View style={styles.rowTextWrap}>
              <View style={styles.flex}>
                <Text style={[styles.rowLabel, { color: hasPassword ? '#E53935' : subText }]}>
                  Reset password
                </Text>
                <Text style={[styles.rowSub, { color: subText }]}>
                  {hasPassword
                    ? 'Clear the current password and set a fresh one'
                    : 'Available once a password is set'}
                </Text>
              </View>
              {hasPassword && (
                <Ionicons name="chevron-forward" size={17} color={subText} />
              )}
            </View>
          </TouchableOpacity>
        </View>
        <Text style={[styles.footerHint, { color: subText }]}>
          The app lock password must be different from your chat delete password.
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {renderHeader()}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {renderHero()}
          {renderToggle()}
          {renderForm()}
          {renderReset()}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  headerBackBtn: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 20,
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 1,
  },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },

  // Hero
  heroWrap: { position: 'relative', marginTop: 4, marginBottom: 22 },
  heroHalo: {
    position: 'absolute',
    top: -40, right: -40,
    width: 200, height: 200, borderRadius: 100,
  },
  heroHalo2: {
    position: 'absolute',
    bottom: -30, left: -40,
    width: 160, height: 160, borderRadius: 80,
  },
  heroCard: {
    borderRadius: 22,
    padding: 22,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 22,
    elevation: 4,
  },
  heroBadge: {
    width: 56, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  heroTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 18,
    marginBottom: 6,
  },
  heroBody: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 19,
  },

  // Sections
  section: { marginBottom: 18 },
  sectionTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 10,
    marginLeft: 8,
  },
  sectionCard: {
    borderRadius: 18,
    overflow: 'hidden',
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 2,
  },

  // Toggle row
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  toggleIconWrap: {
    width: 42, height: 42, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  toggleLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    lineHeight: 20,
  },
  toggleSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },

  // Form
  formCard: {
    borderRadius: 18,
    padding: 16,
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 2,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 50,
    marginBottom: 12,
    gap: 10,
  },
  input: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 15,
    paddingVertical: 0,
  },
  msgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
    marginLeft: 4,
  },
  errorText: {
    color: '#E53935',
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
  },
  successText: {
    color: '#00B894',
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: 14,
    marginTop: 4,
  },
  primaryBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },

  // Reset row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    gap: 14,
  },
  rowIconWrap: {
    width: 42, height: 42, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  rowTextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingRight: 16,
    gap: 10,
  },
  rowLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    lineHeight: 20,
  },
  rowSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },

  footerHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 17,
    paddingHorizontal: 24,
    marginTop: 14,
  },
});
