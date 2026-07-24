import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Animated,
  StyleSheet, TextInput, ActivityIndicator, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { FontAwesome6, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import {
  getUserSettings,
  updateUserSettings,
  verifyTwoStepPassword,
} from '../../Redux/Services/Profile/Settings.Services';
import { getDeletedChatConfig, clearDeletedChatConfig, markDeletedPasswordSet } from '../../utils/deletedChatConfig';

export default function DeletedChatsPassword({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;

  const [loading, setLoading] = useState(true);
  const [hasPassword, setHasPassword] = useState(false);
  // The deleted-chats password can only be configured once the 2-step
  // verification password exists — the panic flow promotes the entered
  // password into the 2-step password, so 2-step must be set up first.
  const [twoStepSet, setTwoStepSet] = useState(false);
  const [armedConfig, setArmedConfig] = useState(null);
  const [pwd, setPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  // Reload the password flag + the armed selection every time the screen is
  // focused — this keeps the status fresh after returning from the chat picker.
  useEffect(() => {
    const load = async () => {
      try {
        const [settings, config] = await Promise.all([
          getUserSettings().catch(() => null),
          getDeletedChatConfig(),
        ]);
        const chat = settings?.chat || {};
        const flag =
          typeof chat.hasDeletedPassword === 'boolean'
            ? chat.hasDeletedPassword
            : !!chat.deletedPassword;
        const two = chat.twoStep || {};
        setHasPassword(flag);
        setTwoStepSet(!!(two.enabled && two.hasPassword));
        setArmedConfig(config);
      } catch {
        /* leave defaults */
      } finally {
        setLoading(false);
      }
    };
    load();
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation]);

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

  // Step 1 of setup: validate the password, then hand off to the chat picker.
  // The password is NOT persisted here — it is committed together with the
  // chosen chats + delete type on the selector's "Set password & arm" action,
  // so the lock is never left half-configured.
  const [checking, setChecking] = useState(false);

  const handleSave = async () => {
    clearMessages();
    // Gate: the deleted-chats password requires an existing 2-step password.
    // Warn and offer to set it up instead of proceeding half-configured.
    if (!twoStepSet) {
      setError('Set up your app lock password first.');
      Alert.alert(
        'Set app lock password first',
        'The chat delete password needs the app lock to be enabled first. Set up your app lock password, then come back to configure this.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Set up app lock',
            onPress: () => navigation.navigate('TwoStepPassword'),
          },
        ]
      );
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
    // The deleted-chats (panic) password must differ from the 2-step password —
    // at the lock screen the two are indistinguishable, so reusing the same
    // value would make one of them unreachable. Catch it here (the backend
    // rejects it too) and warn clearly instead of letting the user proceed to
    // the chat picker only to fail on save with a vague message.
    setChecking(true);
    let clashesWithTwoStep = false;
    try {
      clashesWithTwoStep = await verifyTwoStepPassword(trimmed);
    } catch {
      clashesWithTwoStep = false;
    }
    setChecking(false);
    if (clashesWithTwoStep) {
      setError('This password is already your app lock password. Choose a different one.');
      Alert.alert(
        'Use a different password',
        'Your chat delete password must be different from your app lock password. Please choose a different password.',
        [{ text: 'OK' }]
      );
      return;
    }
    setPwd('');
    setConfirmPwd('');
    navigation.navigate('DeletedChatsSelector', { password: trimmed });
  };

  // Edit only the armed chats / delete type without changing the password.
  const handleEditSelection = () => {
    navigation.navigate('DeletedChatsSelector', {});
  };

  const handleReset = () => {
    if (!hasPassword) return;
    Alert.alert(
      'Reset password?',
      'Your current password will be cleared. The recently-deleted area will be unlocked until you set a new one.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            clearMessages();
            setResetting(true);
            try {
              await updateUserSettings({ chat: { deletedPassword: null } });
              await clearDeletedChatConfig();
              await markDeletedPasswordSet(false);
              setHasPassword(false);
              setArmedConfig(null);
              setPwd('');
              setConfirmPwd('');
              setSuccess('Password reset. You can set a new one below.');
            } catch (e) {
              setError(typeof e === 'string' ? e : 'Could not reset password.');
            } finally {
              setResetting(false);
            }
          },
        },
      ]
    );
  };

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
          Chat delete password
        </Text>
      </View>
    </View>
  );

  // ─── Info hero ───
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
          <Ionicons name="lock-closed" size={26} color={themeColor} />
        </View>
        <Text style={[styles.heroTitle, { color: primaryText }]}>
          Auto-delete chats with a password
        </Text>
        <Text style={[styles.heroBody, { color: subText }]}>
          Set a password and pick the chats plus a delete type. When this
          password is entered at login, those chats are deleted automatically
          and the password is then cleared (single-use). It is hashed on the
          server with bcrypt — never plaintext.
        </Text>

        <View style={[styles.statusPill, {
          backgroundColor: hasPassword ? '#00B89420' : '#FFA50020',
          borderColor: hasPassword ? '#00B89460' : '#FFA50060',
        }]}>
          <View style={[styles.statusDot, {
            backgroundColor: hasPassword ? '#00B894' : '#FFA500',
          }]} />
          <Text style={[styles.statusText, {
            color: hasPassword ? '#00B894' : '#C97B00',
          }]}>
            {hasPassword ? 'Active' : 'Not set'}
          </Text>
        </View>
      </View>
    </Animated.View>
  );

  // ─── Info rows ───
  const renderDetails = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>DETAILS</Text>
      <View style={[styles.sectionCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        <DetailRow
          icon="shield-key-outline"
          label="Hashing"
          value="bcrypt"
          borderClr={borderClr} primaryText={primaryText} subText={subText} themeColor={themeColor}
        />
        <DetailRow
          icon="format-letter-case"
          label="Length"
          value="4 – 128 characters"
          borderClr={borderClr} primaryText={primaryText} subText={subText} themeColor={themeColor}
        />
        <DetailRow
          icon="eye-off-outline"
          label="Stored as"
          value="One-way hash (never plaintext)"
          borderClr={borderClr} primaryText={primaryText} subText={subText} themeColor={themeColor}
          isLast
        />
      </View>
    </View>
  );

  // ─── Form ───
  const renderForm = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>
        {hasPassword ? 'UPDATE PASSWORD' : 'SET PASSWORD'}
      </Text>
      <View style={[styles.formCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        {!loading && !twoStepSet && (
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => navigation.navigate('TwoStepPassword')}
            style={styles.warnBanner}
          >
            <Ionicons name="warning-outline" size={18} color="#C97B00" />
            <View style={styles.flex}>
              <Text style={styles.warnTitle}>App lock password required</Text>
              <Text style={styles.warnBody}>
                Set up your app lock password before you can create
                a chat delete password. Tap to set it up.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#C97B00" />
          </TouchableOpacity>
        )}
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
            editable={!resetting}
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
            editable={!resetting}
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
          disabled={resetting || loading || checking}
          style={[styles.primaryBtn, {
            backgroundColor: themeColor,
            opacity: (resetting || loading || checking) ? 0.7 : 1,
          }]}
        >
          {checking ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="arrow-forward-circle-outline" size={18} color="#fff" />
          )}
          <Text style={styles.primaryBtnText}>
            {hasPassword ? 'Update password & chats' : 'Next: choose chats'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ─── Armed selection summary ───
  // Shown once a password exists. Lets the user review / change which chats
  // are deleted and the delete type, without re-entering the password.
  const renderArmed = () => {
    if (!hasPassword) return null;
    const count = armedConfig?.chatIds?.length || 0;
    const scopeLabel = armedConfig?.scope === 'everyone' ? 'For everyone' : 'For me';
    return (
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: subText }]}>ARMED SELECTION</Text>
        <View style={[styles.sectionCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleEditSelection}
            disabled={resetting}
            style={styles.row}
          >
            <View style={[styles.rowIconWrap, { backgroundColor: themeColor + '1A' }]}>
              <MaterialCommunityIcons name="playlist-remove" size={22} color={themeColor} />
            </View>
            <View style={styles.rowTextWrap}>
              <View style={styles.flex}>
                <Text style={[styles.rowLabel, { color: primaryText }]}>
                  {count > 0 ? `${count} chat${count === 1 ? '' : 's'} armed` : 'No chats selected yet'}
                </Text>
                <Text style={[styles.rowSub, { color: subText }]}>
                  {count > 0
                    ? `${scopeLabel} · tap to change chats or delete type`
                    : 'Tap to choose chats and the delete type'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={subText} />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Reset ───
  const renderReset = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>RECOVERY</Text>
      <View style={[styles.sectionCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={handleReset}
          disabled={!hasPassword || resetting}
          style={styles.row}
        >
          <View style={[styles.rowIconWrap, {
            backgroundColor: hasPassword ? '#E5393520' : (isDarkMode ? '#243340' : '#F2F4F8'),
          }]}>
            {resetting ? (
              <ActivityIndicator size="small" color="#E53935" />
            ) : (
              <MaterialCommunityIcons
                name="lock-reset"
                size={22}
                color={hasPassword ? '#E53935' : subText}
              />
            )}
          </View>
          <View style={styles.rowTextWrap}>
            <View style={styles.flex}>
              <Text style={[styles.rowLabel, {
                color: hasPassword ? '#E53935' : subText,
              }]}>
                Reset password
              </Text>
              <Text style={[styles.rowSub, { color: subText }]}>
                {hasPassword
                  ? 'Clear the current password and start over'
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
        Resetting clears the saved password instantly. There is no email or
        OTP recovery — set a password you can remember.
      </Text>
    </View>
  );

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
          {renderForm()}
          {renderArmed()}
          {renderReset()}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function DetailRow({ icon, label, value, borderClr, primaryText, subText, themeColor, isLast }) {
  return (
    <View style={styles.detailRow}>
      <View style={[styles.detailIconWrap, { backgroundColor: themeColor + '14' }]}>
        <MaterialCommunityIcons name={icon} size={18} color={themeColor} />
      </View>
      <View style={[
        styles.detailTextWrap,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: borderClr },
      ]}>
        <Text style={[styles.detailLabel, { color: subText }]}>{label}</Text>
        <Text style={[styles.detailValue, { color: primaryText }]}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
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
  scrollContent: { paddingHorizontal: 12, paddingBottom: 40 },

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
    marginBottom: 14,
  },
  statusPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 0.4,
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

  // Detail rows
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    gap: 14,
  },
  detailIconWrap: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  detailTextWrap: {
    flex: 1,
    paddingVertical: 14,
    paddingRight: 12,
  },
  detailLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  detailValue: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
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
  warnBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FFA50018',
    borderWidth: 1,
    borderColor: '#FFA50055',
    borderRadius: 14,
    padding: 12,
    marginBottom: 14,
  },
  warnTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 13,
    color: '#C97B00',
    marginBottom: 2,
  },
  warnBody: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    lineHeight: 17,
    color: '#C97B00',
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
    paddingRight: 12,
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
