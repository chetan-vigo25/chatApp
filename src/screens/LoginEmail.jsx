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
import { verify2svService, resend2svService } from "../Redux/Services/Auth/Auth.Services";
import { initSocket, emitLogoutCurrentDevice } from "../Redux/Services/Socket/socket";
import { performSessionReset, saveAuthSession, extractLoginSession } from "../services/sessionManager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { APP_TAG_NAME } from '@env';

// Password length bounds for the sign-in field.
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 10;

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
  const [usernameFocused, setUsernameFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [fcmToken, setFcmToken] = useState(null);

  // Org two-step verification step. Non-null after the backend answered the
  // password login with { requiresTwoStepVerification, challengeToken } — the
  // code arrives in the verified "Talkstry" channel + push on the user's
  // already-signed-in device(s).
  const [twoSv, setTwoSv] = useState(null); // { challengeToken, otpExpiresAt }
  const [otpCode, setOtpCode] = useState("");
  const [twoSvBusy, setTwoSvBusy] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [otpSecondsLeft, setOtpSecondsLeft] = useState(0);
  const isSubmitting = isLoading;

  // Tick both the resend cooldown and the code-expiry countdown.
  useEffect(() => {
    if (!twoSv) return undefined;
    const timer = setInterval(() => {
      setResendCooldown((s) => (s > 0 ? s - 1 : 0));
      if (twoSv.otpExpiresAt) {
        const left = Math.max(0, Math.floor((new Date(twoSv.otpExpiresAt).getTime() - Date.now()) / 1000));
        setOtpSecondsLeft(left);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [twoSv]);

  useEffect(() => {
    AsyncStorage.getItem('fcmToken').then(setFcmToken).catch(() => {});
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  // Username: just required — no length rule.
  const isUsernameValid = username.trim().length > 0;

  // Password: must be MIN_PASSWORD_LENGTH–MAX_PASSWORD_LENGTH characters.
  const passwordLen = password.length;
  const passwordTooLong = passwordLen > MAX_PASSWORD_LENGTH;
  const isPasswordValid = passwordLen >= MIN_PASSWORD_LENGTH && passwordLen <= MAX_PASSWORD_LENGTH;
  // "Too short" nags only after the field is blurred; "too long" shows immediately
  // (it's a definite error the moment they exceed the max).
  const showPasswordError = password.length > 0 && !isPasswordValid && (passwordTouched || passwordTooLong);
  const passwordErrorText = passwordTooLong
    ? `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
    : `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  const isFormValid = isUsernameValid && isPasswordValid;

  const buildDevicePayload = () => ({
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
  });

  // Shared tail of a successful login (normal password login AND 2SV verify).
  const completeLogin = async (loginData) => {
    try { await emitLogoutCurrentDevice(); } catch (_) {}
    await performSessionReset({
      reason: "user_switch_login",
      resetNavigation: false,
      clearAllStorage: true,
      nextUserId: loginData?.data?._id || loginData?.data?.id || null,
    });
    const session = extractLoginSession(loginData);
    await saveAuthSession({
      userInfo: loginData.data,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      deviceId: session.deviceId,
      loginMethod: 'username',
    });
    showToast(loginData.message);
    if (deviceInfo) initSocket(deviceInfo, navigation);
    if (loginData?.data?.isNewUser) {
      navigation.reset({ index: 0, routes: [{ name: "EditProfile", params: { username: username.trim().toLowerCase() } }] });
    } else {
      navigation.reset({ index: 0, routes: [{ name: "SyncScreen", params: { navigateTarget: "ChatList" } }] });
    }
  };

  const handleVerify2sv = async () => {
    if (twoSvBusy || otpCode.trim().length < 6) return;
    setTwoSvBusy(true);
    try {
      const response = await verify2svService({
        challengeToken: twoSv.challengeToken,
        otp: otpCode.trim(),
        device: buildDevicePayload(),
      });
      await completeLogin(response);
    } catch (error) {
      const code = error?.errorCode;
      showToast(error?.message || "Verification failed. Please try again.");
      if (code === 'CHALLENGE_EXPIRED' || code === 'RESEND_LIMIT') {
        // Challenge unusable — back to the password step for a fresh attempt.
        setTwoSv(null);
        setOtpCode("");
      }
    } finally {
      setTwoSvBusy(false);
    }
  };

  const handleResend2sv = async () => {
    if (twoSvBusy || resendCooldown > 0) return;
    setTwoSvBusy(true);
    try {
      const response = await resend2svService({ challengeToken: twoSv.challengeToken });
      setTwoSv((prev) => ({ ...prev, otpExpiresAt: response?.data?.otpExpiresAt || prev.otpExpiresAt }));
      setOtpCode("");
      setResendCooldown(45);
      showToast(response?.message || "A new code was sent.");
    } catch (error) {
      const code = error?.errorCode;
      showToast(error?.message || "Could not resend code.");
      if (code === 'CHALLENGE_EXPIRED' || code === 'RESEND_LIMIT') {
        setTwoSv(null);
        setOtpCode("");
      }
    } finally {
      setTwoSvBusy(false);
    }
  };

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
      // Org 2SV: password accepted but no tokens yet — the code was posted to
      // the user's Talkstry system channel (+ push). Switch to the OTP step.
      if (loginData?.data?.requiresTwoStepVerification) {
        setTwoSv({
          challengeToken: loginData.data.challengeToken,
          otpExpiresAt: loginData.data.otpExpiresAt || null,
        });
        setOtpCode("");
        setResendCooldown(45);
        showToast(loginData.message || "Verification code sent to your Talkstry app.");
        return;
      }
      await completeLogin(loginData);
    } catch (error) {
      showToast(typeof error === "string" ? error : "Login failed. Please try again.");
    }
  };

  // WhatsApp palette
  const accent = isDarkMode ? theme.colors.themeColor : '#028578';
  const link = isDarkMode ? '#53BDEB' : '#027EB5';
  const errorColor = '#E5484D';
  const bg = isDarkMode ? '#000000' : '#FFFFFF';
  const primaryText = isDarkMode ? '#E9EDEF' : '#111B21';
  const secondaryText = isDarkMode ? theme.colors.secondaryTextColor : '#54656F';
  const placeholderText = isDarkMode ? '#5E7280' : '#A6B0BD';
  const underlineIdle = isDarkMode ? '#2A3942' : '#D1D7DB';
  const disabledBtn = isDarkMode ? '#1F2C33' : '#D8DEE2';
  const disabledTxt = isDarkMode ? '#54656F' : '#9AA6AE';

  const usernameUnderline = usernameFocused ? accent : underlineIdle;
  const passwordUnderline = showPasswordError ? errorColor : (passwordFocused ? accent : underlineIdle);

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
            {twoSv ? (
              <>
                <Text style={[styles.heading, { color: primaryText }]}>Two-step verification</Text>
                <Text style={[styles.blurb, { color: secondaryText }]}>
                  We sent a 6-digit code to the verified Talkstry channel in your chat list (and as a notification) on your signed-in device. Enter it below to finish signing in.
                </Text>
                <Text style={[styles.label, { color: secondaryText }]}>VERIFICATION CODE</Text>
                <View style={[styles.inputRow, { borderBottomColor: accent }]}>
                  <Ionicons name="shield-checkmark-outline" size={20} color={accent} style={styles.inputIcon} />
                  <TextInput keyboardAppearance={isDarkMode ? 'dark' : 'light'}
                    style={[styles.input, { color: primaryText }]}
                    placeholder="6-digit code"
                    placeholderTextColor={placeholderText}
                    value={otpCode}
                    onChangeText={(v) => setOtpCode(v.replace(/[^0-9]/g, ""))}
                    keyboardType="number-pad"
                    maxLength={6}
                    returnKeyType="done"
                    onSubmitEditing={handleVerify2sv}
                    autoFocus
                  />
                </View>
                {otpSecondsLeft > 0 ? (
                  <Text style={[styles.countdown, { color: secondaryText }]}>
                    Code expires in {Math.floor(otpSecondsLeft / 60)}:{String(otpSecondsLeft % 60).padStart(2, '0')}
                  </Text>
                ) : (
                  <Text style={[styles.countdown, { color: errorColor }]}>
                    Code expired — tap Resend to get a new one.
                  </Text>
                )}
              </>
            ) : (
              <>
            <Text style={[styles.heading, { color: primaryText }]}>
              Sign in to {String(APP_TAG_NAME || 'continue')}
            </Text>
            <Text style={[styles.blurb, { color: secondaryText }]}>
              Enter the username and password provided to you to access your conversations.
            </Text>

            {/* Username */}
            <Text style={[styles.label, { color: secondaryText }]}>USERNAME</Text>
            <View style={[styles.inputRow, { borderBottomColor: usernameUnderline }]}>
              <Ionicons name="person-outline" size={20} color={usernameFocused ? accent : placeholderText} style={styles.inputIcon} />
              <TextInput keyboardAppearance={isDarkMode ? 'dark' : 'light'}
                style={[styles.input, { color: primaryText }]}
                placeholder="Username"
                placeholderTextColor={placeholderText}
                value={username}
                onChangeText={setUsername}
                onFocus={() => setUsernameFocused(true)}
                onBlur={() => setUsernameFocused(false)}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
              />
            </View>

            {/* Password */}
            <Text style={[styles.label, { color: secondaryText, marginTop: 26 }]}>PASSWORD</Text>
            <View style={[styles.inputRow, { borderBottomColor: passwordUnderline }]}>
              <Ionicons name="lock-closed-outline" size={20} color={showPasswordError ? errorColor : (passwordFocused ? accent : placeholderText)} style={styles.inputIcon} />
              <TextInput keyboardAppearance={isDarkMode ? 'dark' : 'light'}
                style={[styles.input, { color: primaryText }]}
                placeholder="Enter your password"
                placeholderTextColor={placeholderText}
                value={password}
                onChangeText={setPassword}
                // Cap above the max so the user CAN exceed 10 and see the "too long"
                // error, but can't type an unbounded string.
                maxLength={MAX_PASSWORD_LENGTH + 10}
                onFocus={() => setPasswordFocused(true)}
                onBlur={() => { setPasswordTouched(true); setPasswordFocused(false); }}
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
            {showPasswordError ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle" size={14} color={errorColor} />
                <Text style={styles.errorText}>{passwordErrorText}</Text>
              </View>
            ) : null}
              </>
            )}
          </Animated.View>
        </ScrollView>

        {/* Bottom actions */}
        <View style={styles.bottomArea}>
          {twoSv ? (
            <>
              <TouchableOpacity
                onPress={handleVerify2sv}
                disabled={otpCode.length < 6 || twoSvBusy}
                activeOpacity={0.85}
                style={[styles.cta, { backgroundColor: otpCode.length === 6 && !twoSvBusy ? accent : disabledBtn }]}
              >
                {twoSvBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={[styles.ctaText, { color: otpCode.length === 6 ? '#FFFFFF' : disabledTxt }]}>VERIFY</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleResend2sv}
                disabled={resendCooldown > 0 || twoSvBusy}
                activeOpacity={0.75}
                style={[styles.altBtn, styles.resendBtn, { borderColor: resendCooldown > 0 ? disabledBtn : accent }]}
              >
                <Ionicons name="refresh-outline" size={18} color={resendCooldown > 0 ? disabledTxt : accent} />
                <Text style={[styles.altBtnText, { color: resendCooldown > 0 ? disabledTxt : accent }]}>
                  {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => { setTwoSv(null); setOtpCode(""); }}
                activeOpacity={0.75}
                style={styles.backLink}
              >
                <Text style={[styles.altBtnText, { color: link }]}>Back to sign in</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
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
            </>
          )}

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
    paddingHorizontal: 12,
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
  resendBtn: { marginTop: 16 },
  backLink: { alignSelf: 'center', marginTop: 18 },
  countdown: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 12,
  },

  footer: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 18,
  },
});
