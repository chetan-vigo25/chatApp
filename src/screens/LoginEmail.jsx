import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity, Animated,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  Alert, ToastAndroid,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../contexts/ThemeContext";
import { useDeviceInfo } from "../contexts/DeviceInfoContext";
import { useDeviceLocation } from "../contexts/DeviceLoc";
import { useDispatch, useSelector } from "react-redux";
import { emailLogin } from "../Redux/Reducer/Auth/Auth.reducer";
import { initSocket, emitLogoutCurrentDevice } from "../Redux/Services/Socket/socket";
import { performSessionReset, saveAuthSession } from "../services/sessionManager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { APP_TAG_NAME } from '@env';

// Minimum length for the system-generated username (e.g. "ballu1").
const MIN_USERNAME_LENGTH = 3;

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

export default function LoginEmail({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const deviceInfo = useDeviceInfo();
  const { location, address } = useDeviceLocation();
  const dispatch = useDispatch();
  const { isLoading } = useSelector((state) => state.authentication);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(14)).current;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [usernameFocused, setUsernameFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [fcmToken, setFcmToken] = useState(null);
  const isSubmitting = isLoading;

  useEffect(() => {
    AsyncStorage.getItem('fcmToken').then(setFcmToken).catch(() => {});
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  const isUsernameValid = username.trim().length >= MIN_USERNAME_LENGTH;
  const showUsernameError = usernameTouched && username.length > 0 && !isUsernameValid;
  const isFormValid = isUsernameValid && password.length >= 1;

  const handleSubmit = async () => {
    if (!isFormValid || isLoading) return;
    const payload = {
      userName: username.trim().toLowerCase(),
      password,
      isLoginByUsername: true,
      device: {
        deviceName: deviceInfo?.brand || "Unknown",
        deviceType: deviceInfo?.deviceType || "mobile",
        os: deviceInfo?.osName || Platform.OS,
        appVersion: deviceInfo?.appVersion || "1.0.0",
        fcmToken: fcmToken || "",
        location: location && address?.[0]
          ? {
              lat: location.coords.latitude,
              lng: location.coords.longitude,
              street: address[0].street || "",
              city: address[0].city || "",
              state: address[0].state || "",
              country: address[0].country || "",
              zipCode: address[0].postalCode || "",
              timezone: address[0].timezone || "",
            }
          : {},
      },
    };

    try {
      const loginData = await dispatch(emailLogin(payload)).unwrap();
      // M6 — single-account: force-logout the previous account server-side
      // (best-effort) before wiping local state and switching.
      try { await emitLogoutCurrentDevice(); } catch (_) {}
      // Pass the incoming userId so the reset KEEPS the local SQLite cache on a
      // same-account re-login (instant local-first load) and only wipes it when
      // a different user signs in on this device.
      await performSessionReset({
        reason: "user_switch_login",
        resetNavigation: false,
        clearAllStorage: true,
        nextUserId: loginData?.data?._id || loginData?.data?.id || null,
      });
      await saveAuthSession({
        userInfo: loginData.data,
        accessToken: loginData?.token?.accessToken,
        refreshToken: loginData?.token?.refreshToken,
        deviceId: loginData?.data?.deviceId,
        loginMethod: 'username',
      });
      showToast(loginData.message);
      if (deviceInfo) initSocket(deviceInfo, navigation);
      if (loginData?.data?.isNewUser) {
        navigation.reset({ index: 0, routes: [{ name: "EditProfile", params: { username: username.trim().toLowerCase() } }] });
      } else {
        navigation.reset({ index: 0, routes: [{ name: "SyncScreen", params: { navigateTarget: "ChatList" } }] });
      }
    } catch (error) {
      showToast(typeof error === "string" ? error : "Login failed. Please try again.");
    }
  };

  // WhatsApp palette
  const accent = isDarkMode ? '#00A884' : '#008069';
  const link = isDarkMode ? '#53BDEB' : '#027EB5';
  const errorColor = '#E5484D';
  const bg = isDarkMode ? '#0B141A' : '#FFFFFF';
  const primaryText = isDarkMode ? '#E9EDEF' : '#111B21';
  const secondaryText = isDarkMode ? '#8696A0' : '#54656F';
  const placeholderText = isDarkMode ? '#5E7280' : '#A6B0BD';
  const underlineIdle = isDarkMode ? '#2A3942' : '#D1D7DB';
  const disabledBtn = isDarkMode ? '#1F2C33' : '#D8DEE2';
  const disabledTxt = isDarkMode ? '#54656F' : '#9AA6AE';

  const usernameUnderline = showUsernameError ? errorColor : (usernameFocused ? accent : underlineIdle);
  const passwordUnderline = passwordFocused ? accent : underlineIdle;

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        {/* <TouchableOpacity
          onPress={() => navigation?.goBack?.()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.6}
        >
          <Ionicons name="arrow-back" size={24} color={secondaryText} />
        </TouchableOpacity> */}
        <Text style={[styles.topTitle, { color: accent }]} numberOfLines={1}>Sign in</Text>
        <View style={styles.topSpacer} />
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
            <Text style={[styles.heading, { color: primaryText }]}>
              Sign in to {String(APP_TAG_NAME || 'continue')}
            </Text>
            <Text style={[styles.blurb, { color: secondaryText }]}>
              Enter the username and password provided to you to access your conversations.
            </Text>

            {/* Username */}
            <Text style={[styles.label, { color: secondaryText }]}>USERNAME</Text>
            <View style={[styles.inputRow, { borderBottomColor: usernameUnderline }]}>
              <Ionicons name="person-outline" size={20} color={showUsernameError ? errorColor : (usernameFocused ? accent : placeholderText)} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: primaryText }]}
                placeholder="UserName"
                placeholderTextColor={placeholderText}
                value={username}
                onChangeText={setUsername}
                onFocus={() => setUsernameFocused(true)}
                onBlur={() => { setUsernameTouched(true); setUsernameFocused(false); }}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
              />
            </View>
            {showUsernameError ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle" size={14} color={errorColor} />
                <Text style={styles.errorText}>Username must be at least {MIN_USERNAME_LENGTH} characters</Text>
              </View>
            ) : null}

            {/* Password */}
            <Text style={[styles.label, { color: secondaryText, marginTop: 26 }]}>PASSWORD</Text>
            <View style={[styles.inputRow, { borderBottomColor: passwordUnderline }]}>
              <Ionicons name="lock-closed-outline" size={20} color={passwordFocused ? accent : placeholderText} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: primaryText }]}
                placeholder="Enter your password"
                placeholderTextColor={placeholderText}
                value={password}
                onChangeText={setPassword}
                onFocus={() => setPasswordFocused(true)}
                onBlur={() => setPasswordFocused(false)}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="password"
                textContentType="password"
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
              />
              <TouchableOpacity
                onPress={() => setShowPassword((p) => !p)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.eyeBtn}
              >
                <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={22} color={placeholderText} />
              </TouchableOpacity>
            </View>
          </Animated.View>
        </ScrollView>

        {/* Bottom actions */}
        <View style={styles.bottomArea}>
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={!isFormValid || isSubmitting}
            activeOpacity={0.85}
            style={[styles.cta, { backgroundColor: isFormValid ? accent : disabledBtn }]}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={[styles.ctaText, { color: isFormValid ? '#FFFFFF' : disabledTxt }]}>SIGN IN</Text>
            )}
          </TouchableOpacity>

          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: underlineIdle }]} />
            <Text style={[styles.dividerText, { color: secondaryText }]}>OR</Text>
            <View style={[styles.dividerLine, { backgroundColor: underlineIdle }]} />
          </View>

          <TouchableOpacity
            onPress={() => navigation?.navigate('Login')}
            activeOpacity={0.75}
            style={[styles.altBtn, { borderColor: accent }]}
          >
            <Ionicons name="call-outline" size={18} color={accent} />
            <Text style={[styles.altBtnText, { color: accent }]}>Continue with phone</Text>
          </TouchableOpacity>

          <Text style={[styles.footer, { color: secondaryText }]}>
            Protected by end-to-end encryption
          </Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },

  topBar: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  topTitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 19,
    letterSpacing: 0.15,
    marginLeft: 20,
    flex: 1,
  },
  topSpacer: { width: 24 },

  scroll: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 16 },
  content: { paddingTop: 8 },

  heading: {
    fontFamily: 'Roboto-Medium',
    fontSize: 22,
    marginBottom: 8,
  },
  blurb: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 36,
  },

  label: {
    fontFamily: 'Roboto-Medium',
    fontSize: 12,
    letterSpacing: 1,
    marginBottom: 6,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    borderBottomWidth: 2,
  },
  inputIcon: { marginRight: 12 },
  input: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 16,
    paddingVertical: 0,
  },
  eyeBtn: { paddingLeft: 12 },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  errorText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    color: '#E5484D',
  },

  bottomArea: {
    paddingHorizontal: 28,
    paddingBottom: 28,
    paddingTop: 8,
  },
  cta: {
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    letterSpacing: 1.2,
  },

  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
  },
  dividerLine: { flex: 1, height: 1 },
  dividerText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 11,
    marginHorizontal: 14,
    letterSpacing: 1,
  },

  altBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
  },
  altBtnText: { fontFamily: 'Roboto-Medium', fontSize: 14 },

  footer: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 18,
  },
});
