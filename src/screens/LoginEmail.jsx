import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Animated,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
  ScrollView,
  Alert,
  ToastAndroid,
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

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

export default function LoginEmail({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const deviceInfo = useDeviceInfo();
  const { location, address, requestLocationPermission } = useDeviceLocation();
  const dispatch = useDispatch();
  const { isLoading } = useSelector((state) => state.authentication);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const cardScale = useRef(new Animated.Value(0.95)).current;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [fcmToken, setFcmToken] = useState(null);
  const isSubmitting = isLoading;

  // Focus glow animations
  const emailGlow = useRef(new Animated.Value(0)).current;
  const passwordGlow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    requestLocationPermission();
    AsyncStorage.getItem('fcmToken').then(setFcmToken).catch(() => {});

    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.spring(cardScale, {
        toValue: 1,
        friction: 8,
        tension: 40,
        useNativeDriver: true,
      }),
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
      password: password,
      // otp: "111111",
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

      await performSessionReset({
        reason: "user_switch_login",
        resetNavigation: false,
        clearAllStorage: true,
      });

      await saveAuthSession({
        userInfo: loginData.data,
        accessToken: loginData?.token?.accessToken,
        refreshToken: loginData?.token?.refreshToken,
        deviceId: loginData?.data?.deviceId,
      });

      showToast(loginData.message);

      if (deviceInfo) {
        initSocket(deviceInfo, navigation);
      }

      if (loginData?.data?.isNewUser) {
        navigation.reset({
          index: 0,
          routes: [{ name: "EditProfile", params: { email: email.trim() } }],
        });
      } else {
        navigation.reset({
          index: 0,
          routes: [{ name: "SyncScreen", params: { navigateTarget: "ChatList" } }],
        });
      }
    } catch (error) {
      console.error("Email login failed:", error);
      showToast(typeof error === "string" ? error : "Login failed. Please try again.");
    }
  };

  const colors = {
    bg: isDarkMode ? "#0B141A" : "#F0F2F5",
    card: isDarkMode ? "#1B2831" : "#FFFFFF",
    inputBg: isDarkMode ? "#233040" : "#F7F8FA",
    inputBorder: isDarkMode ? "#2A3942" : "#E0E0E0",
    focusBorder: theme.colors.themeColor,
    errorBorder: "#E53935",
    errorText: "#E53935",
    title: isDarkMode ? "#FFFFFF" : "#1A1A1A",
    subtitle: theme.colors.placeHolderTextColor,
    inputText: isDarkMode ? "#FFFFFF" : "#1A1A1A",
    placeholder: isDarkMode ? "#6B7B8A" : "#9E9E9E",
    checkboxBg: theme.colors.themeColor,
    linkColor: theme.colors.themeColor,
    disabledBtn: isDarkMode ? "#1E3A3A" : "#B2DFDB",
    shadow: isDarkMode ? "transparent" : "#00000015",
  };

  const getInputBorderColor = (glowAnim, hasError) => {
    if (hasError) return colors.errorBorder;
    return glowAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [colors.inputBorder, colors.focusBorder],
    });
  };

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} >
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, backgroundColor: colors.bg, }} keyboardShouldPersistTaps="handled" >
          <Animated.View
            style={{ transform: [{ scale: cardScale }],  backgroundColor: colors.card,  borderRadius: 20, padding: 28,
              shadowColor: colors.shadow,
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 1,
              shadowRadius: 24,
              elevation: isDarkMode ? 0 : 8, }} >
            {/* Header */}
            <View style={{ alignItems: "center", marginBottom: 32 }}>
              <View style={{ width: 56,  height: 56, borderRadius: 16, backgroundColor: theme.colors.themeColor + "18", alignItems: "center", justifyContent: "center", marginBottom: 16, }} >
                <Image source={require('../../assets/icon0.png')} resizeMode="cover" style={{ width:46, height:46 }} />
              </View>
              <Text style={{ fontFamily: "Roboto-Bold", fontSize: 24, color: colors.title, marginBottom: 6,}}>
                Welcome Back
              </Text>
              <Text style={{ fontFamily: "Roboto-Regular", fontSize: 14, color: colors.subtitle, textAlign: "center", }} >
                Sign in with your email and password
              </Text>
            </View>

            {/* Email Input */}
            <View style={{ marginBottom: 18 }}>
              <Text style={{ fontFamily: "Roboto-Medium", fontSize: 13, color: colors.subtitle, marginBottom: 8, marginLeft: 2, }} >
                Email
              </Text>
              <Animated.View style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.inputBg, borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 14, height: 50,
                  borderColor: getInputBorderColor(emailGlow, showEmailError),
                   }} >
                <Ionicons
                  name="mail-outline"
                  size={20} color={showEmailError ? colors.errorBorder : colors.placeholder}
                  style={{ marginRight: 10 }} />
                <TextInput style={{ flex: 1, fontFamily: "Roboto-Regular", fontSize: 15, color: colors.inputText, paddingVertical: 0,}}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.placeholder}
                  value={email}
                  onChangeText={setEmail}
                  onFocus={() => animateFocus(emailGlow, true)}
                  onBlur={() => {
                    setEmailTouched(true);
                    animateFocus(emailGlow, false);
                  }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  accessibilityLabel="Email address"
                  accessibilityHint="Enter your email address"
                  returnKeyType="next"
                />
              </Animated.View>
              {showEmailError && (
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6, marginLeft: 4, }}>
                  <Ionicons name="alert-circle" size={14} color={colors.errorText} style={{ marginRight: 4 }} />
                  <Text style={{ fontFamily: "Roboto-Regular", fontSize: 12, color: colors.errorText, }}
                    accessibilityRole="alert"
                  >
                    Please enter a valid email address
                  </Text>
                </View>
              )}
            </View>

            {/* Password Input */}
            <View style={{ marginBottom: 18 }}>
              <Text style={{ fontFamily: "Roboto-Medium", fontSize: 13, color: colors.subtitle, marginBottom: 8, marginLeft: 2, }} >
                Password
              </Text>
              <Animated.View style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.inputBg, borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 14, height: 50,
                  borderColor: getInputBorderColor(passwordGlow, false),
                   }} >
                <Ionicons name="lock-closed-outline" size={20} color={colors.placeholder} style={{ marginRight: 10 }} />
                <TextInput style={{ flex: 1, fontFamily: "Roboto-Regular", fontSize: 15, color: colors.inputText, paddingVertical: 0, }}
                  placeholder="Enter your password"
                  placeholderTextColor={colors.placeholder}
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => animateFocus(passwordGlow, true)}
                  onBlur={() => animateFocus(passwordGlow, false)}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="password"
                  textContentType="password"
                  accessibilityLabel="Password"
                  accessibilityHint="Enter your password"
                  returnKeyType="done"
                  onSubmitEditing={handleSubmit}
                />
                <TouchableOpacity onPress={() => setShowPassword((prev) => !prev)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityLabel={
                    showPassword ? "Hide password" : "Show password"
                  } accessibilityRole="button" >
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={22} color={colors.placeholder} />
                </TouchableOpacity>
              </Animated.View>
            </View>

            {/* Remember Me & Forgot Password */}
            {/* <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 28, }} >
              <TouchableOpacity
                style={{ flexDirection: "row", alignItems: "center" }}
                onPress={() => setRememberMe((prev) => !prev)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: rememberMe }}
                accessibilityLabel="Remember me"
              >
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: rememberMe
                      ? colors.checkboxBg
                      : colors.inputBorder,
                    backgroundColor: rememberMe
                      ? colors.checkboxBg
                      : "transparent",
                    alignItems: "center", justifyContent: "center", marginRight: 8,
                  }}
                >
                  {rememberMe && (
                    <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                  )}
                </View>
                <Text style={{ fontFamily: "Roboto-Regular", fontSize: 13, color: colors.subtitle,}} >
                  Remember me
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => navigation?.navigate("ForgotPassword")}
                accessibilityRole="link"
                accessibilityLabel="Forgot password"
              >
                <Text style={{ fontFamily: "Roboto-Medium", fontSize: 13, color: colors.linkColor, }} >
                  Forgot Password?
                </Text>
              </TouchableOpacity>
            </View> */}

            {/* Submit Button */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!isFormValid || isSubmitting}
              activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Sign in"
              accessibilityState={{ disabled: !isFormValid || isSubmitting }}
              style={{
                height: 50,
                borderRadius: 12,
                backgroundColor: isFormValid
                  ? theme.colors.themeColor
                  : colors.disabledBtn,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={{ fontFamily: "Roboto-SemiBold", fontSize: 16, color: isFormValid ? "#FFFFFF" : (isDarkMode ? "#5A7A7A" : "#80CBC4"), letterSpacing: 0.5, }} >
                  Sign In
                </Text>
              )}
            </TouchableOpacity>

            {/* Divider */}
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 20, }} >
              <View style={{ flex: 1, height: 1, backgroundColor: colors.inputBorder,}} />
              <Text style={{ fontFamily: "Roboto-Regular", fontSize: 12, color: colors.subtitle, marginHorizontal: 14, }} >
                OR
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.inputBorder, }}  />
            </View>

            {/* Phone Login Link */}
            <TouchableOpacity
              onPress={() => navigation?.navigate("Login")}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Sign in with phone number"
              style={{ height: 50, borderRadius: 12, borderWidth: 1.5, borderColor: colors.inputBorder, alignItems: "center", justifyContent: "center", flexDirection: "row", }}  >
              <Ionicons  name="call-outline" size={18} color={colors.linkColor} style={{ marginRight: 8 }} />
              <Text style={{ fontFamily: "Roboto-Medium", fontSize: 14,}}>
                Sign in with Phone Number
              </Text>
            </TouchableOpacity>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Animated.View>
  );
}
