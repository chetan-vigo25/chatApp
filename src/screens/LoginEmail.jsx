import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity, Animated,
  ActivityIndicator, KeyboardAvoidingView, Platform, Image, ScrollView,
  Alert, ToastAndroid, Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../contexts/ThemeContext";
import { useDeviceInfo } from "../contexts/DeviceInfoContext";
import { useDeviceLocation } from "../contexts/DeviceLoc";
import { useDispatch, useSelector } from "react-redux";
import { emailLogin } from "../Redux/Reducer/Auth/Auth.reducer";
import { initSocket } from "../Redux/Services/Socket/socket";
import { performSessionReset, saveAuthSession } from "../services/sessionManager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { APP_TAG_NAME } from '@env';

const { width: SCREEN_W } = Dimensions.get('window');
const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

// Stacked-bands radial halo
function HeroHalo({ color }) {
  const BANDS = 12;
  return (
    <View pointerEvents="none" style={styles.heroHalo}>
      {Array.from({ length: BANDS }).map((_, i) => {
        const t = (BANDS - i) / BANDS;
        const alpha = Number((t * t * 0.18).toFixed(3));
        return (
          <View
            key={i}
            style={[
              styles.heroHaloBand,
              { backgroundColor: color, opacity: alpha, transform: [{ scale: 1 + i * 0.06 }] },
            ]}
          />
        );
      })}
    </View>
  );
}

export default function LoginEmail({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const deviceInfo = useDeviceInfo();
  const { location, address } = useDeviceLocation();
  const dispatch = useDispatch();
  const { isLoading } = useSelector((state) => state.authentication);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const emailGlow = useRef(new Animated.Value(0)).current;
  const passwordGlow = useRef(new Animated.Value(0)).current;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [fcmToken, setFcmToken] = useState(null);
  const isSubmitting = isLoading;

  useEffect(() => {
    AsyncStorage.getItem('fcmToken').then(setFcmToken).catch(() => {});
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  const isEmailValid = EMAIL_REGEX.test(email.trim());
  const showEmailError = emailTouched && email.length > 0 && !isEmailValid;
  const isFormValid = isEmailValid && password.length >= 1;

  const animateFocus = useCallback((animValue, focused) => {
    Animated.timing(animValue, {
      toValue: focused ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, []);

  const handleSubmit = async () => {
    if (!isFormValid || isLoading) return;
    const payload = {
      userName: email.trim(),
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
      await performSessionReset({ reason: "user_switch_login", resetNavigation: false, clearAllStorage: true });
      await saveAuthSession({
        userInfo: loginData.data,
        accessToken: loginData?.token?.accessToken,
        refreshToken: loginData?.token?.refreshToken,
        deviceId: loginData?.data?.deviceId,
      });
      showToast(loginData.message);
      if (deviceInfo) initSocket(deviceInfo, navigation);
      if (loginData?.data?.isNewUser) {
        navigation.reset({ index: 0, routes: [{ name: "EditProfile", params: { email: email.trim() } }] });
      } else {
        navigation.reset({ index: 0, routes: [{ name: "SyncScreen", params: { navigateTarget: "ChatList" } }] });
      }
    } catch (error) {
      showToast(typeof error === "string" ? error : "Login failed. Please try again.");
    }
  };

  const themeColor = theme.colors.themeColor;
  const bg = isDarkMode ? '#0B141A' : '#F4F6F9';
  const card = isDarkMode ? '#16222C' : '#FFFFFF';
  const inputBg = isDarkMode ? '#1F2C36' : '#F6F8FB';
  const inputBorderIdle = isDarkMode ? '#243340' : '#E6EAF0';
  const errorColor = '#E5484D';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const placeholderColor = isDarkMode ? '#5E7280' : '#A6B0BD';

  const getBorder = (glow, hasError) => {
    if (hasError) return errorColor;
    return glow.interpolate({ inputRange: [0, 1], outputRange: [inputBorderIdle, themeColor] });
  };

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <HeroHalo color={themeColor} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
            {/* Brand mark */}
            <View style={styles.brandWrap}>
              <View style={[styles.brandRing, { borderColor: themeColor + '22' }]}>
                <View style={[styles.brandRing2, { borderColor: themeColor + '38' }]}>
                  <View style={[styles.brandBadge, { backgroundColor: themeColor + '18' }]}>
                    <Image source={require('../../assets/icon0.png')} resizeMode="cover" style={styles.brandLogo} />
                  </View>
                </View>
              </View>
            </View>

            <Text style={[styles.eyebrow, { color: themeColor }]}>WELCOME BACK</Text>
            <Text style={[styles.title, { color: primaryText }]}>Sign in to{'\n'}{APP_TAG_NAME || 'continue'}</Text>
            <Text style={[styles.subtitle, { color: subText }]}>
              Use your email and password to access your conversations.
            </Text>

            {/* Card */}
            <View style={[styles.card, { backgroundColor: card, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
              {/* Email */}
              <Text style={[styles.label, { color: subText }]}>EMAIL</Text>
              <Animated.View style={[styles.inputRow, { backgroundColor: inputBg, borderColor: getBorder(emailGlow, showEmailError) }]}>
                <Ionicons name="mail-outline" size={20} color={showEmailError ? errorColor : placeholderColor} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { color: primaryText }]}
                  placeholder="you@example.com"
                  placeholderTextColor={placeholderColor}
                  value={email}
                  onChangeText={setEmail}
                  onFocus={() => animateFocus(emailGlow, true)}
                  onBlur={() => { setEmailTouched(true); animateFocus(emailGlow, false); }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="next"
                />
              </Animated.View>
              {showEmailError && (
                <View style={styles.errorRow}>
                  <Ionicons name="alert-circle" size={14} color={errorColor} />
                  <Text style={styles.errorText}>Please enter a valid email address</Text>
                </View>
              )}

              {/* Password */}
              <Text style={[styles.label, { color: subText, marginTop: 18 }]}>PASSWORD</Text>
              <Animated.View style={[styles.inputRow, { backgroundColor: inputBg, borderColor: getBorder(passwordGlow, false) }]}>
                <Ionicons name="lock-closed-outline" size={20} color={placeholderColor} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { color: primaryText }]}
                  placeholder="Enter your password"
                  placeholderTextColor={placeholderColor}
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => animateFocus(passwordGlow, true)}
                  onBlur={() => animateFocus(passwordGlow, false)}
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
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={22} color={placeholderColor} />
                </TouchableOpacity>
              </Animated.View>

              {/* CTA */}
              <TouchableOpacity
                onPress={handleSubmit}
                disabled={!isFormValid || isSubmitting}
                activeOpacity={0.85}
                style={[styles.cta, { backgroundColor: isFormValid ? themeColor : themeColor + '55' }]}
              >
                {isSubmitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Text style={styles.ctaText}>Sign in</Text>
                    <Ionicons name="arrow-forward" size={18} color="#fff" />
                  </>
                )}
              </TouchableOpacity>

              {/* Divider */}
              <View style={styles.dividerRow}>
                <View style={[styles.dividerLine, { backgroundColor: inputBorderIdle }]} />
                <Text style={[styles.dividerText, { color: subText }]}>OR</Text>
                <View style={[styles.dividerLine, { backgroundColor: inputBorderIdle }]} />
              </View>

              {/* Phone alt */}
              <TouchableOpacity
                onPress={() => navigation?.navigate('Login')}
                activeOpacity={0.75}
                style={[styles.altBtn, { borderColor: inputBorderIdle }]}
              >
                <Ionicons name="call-outline" size={18} color={themeColor} />
                <Text style={[styles.altBtnText, { color: themeColor }]}>Continue with Phone</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Text style={[styles.footer, { color: subText }]}>
        Protected by end-to-end encryption
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 28, paddingBottom: 16 },
  content: { flex: 1, justifyContent: 'center' },

  heroHalo: {
    position: 'absolute',
    top: -SCREEN_W * 0.55,
    left: -SCREEN_W * 0.25,
    width: SCREEN_W * 1.5,
    height: SCREEN_W * 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  heroHaloBand: {
    position: 'absolute',
    width: SCREEN_W, height: SCREEN_W, borderRadius: SCREEN_W / 2,
  },

  brandWrap: { alignItems: 'center', marginBottom: 22 },
  brandRing: {
    width: 100, height: 100, borderRadius: 50,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  brandRing2: {
    width: 82, height: 82, borderRadius: 41,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  brandBadge: {
    width: 64, height: 64, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  brandLogo: { width: 48, height: 48, borderRadius: 12 },

  eyebrow: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11, letterSpacing: 2,
    textAlign: 'center', marginBottom: 8,
  },
  title: {
    fontFamily: 'Roboto-Bold',
    fontSize: 26, lineHeight: 32,
    textAlign: 'center', letterSpacing: -0.4,
  },
  subtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14, textAlign: 'center',
    marginTop: 8, marginBottom: 22,
    paddingHorizontal: 16, lineHeight: 20,
  },

  card: {
    borderRadius: 22, padding: 18,
    shadowOpacity: 0.06, shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24, elevation: 4,
  },
  label: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11, letterSpacing: 1.2,
    marginBottom: 8, marginLeft: 4,
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    height: 54, borderRadius: 14, borderWidth: 1.5,
    paddingHorizontal: 14,
  },
  inputIcon: { marginRight: 10 },
  input: {
    flex: 1, fontFamily: 'Roboto-Regular',
    fontSize: 15, paddingVertical: 0,
  },
  eyeBtn: { paddingLeft: 10 },
  errorRow: {
    flexDirection: 'row', alignItems: 'center',
    gap: 6, marginTop: 8, marginLeft: 4,
  },
  errorText: {
    fontFamily: 'Roboto-Regular', fontSize: 12, color: '#E5484D',
  },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 54, borderRadius: 16, marginTop: 22,
  },
  ctaText: {
    color: '#fff', fontFamily: 'Roboto-SemiBold',
    fontSize: 16, letterSpacing: 0.3,
  },

  dividerRow: {
    flexDirection: 'row', alignItems: 'center', marginVertical: 18,
  },
  dividerLine: { flex: 1, height: 1 },
  dividerText: {
    fontFamily: 'Roboto-Medium', fontSize: 11,
    marginHorizontal: 12, letterSpacing: 1,
  },

  altBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 50, borderRadius: 14, borderWidth: 1.5,
  },
  altBtnText: { fontFamily: 'Roboto-SemiBold', fontSize: 14 },

  footer: {
    fontFamily: 'Roboto-Regular', fontSize: 11,
    textAlign: 'center', paddingBottom: 14,
  },
});
