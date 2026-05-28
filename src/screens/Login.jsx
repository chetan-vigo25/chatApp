import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet, View, Text, ActivityIndicator, Animated,
  TouchableOpacity, TextInput, Alert, Platform, ToastAndroid,
  KeyboardAvoidingView, ScrollView, Image, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import CountryCodeSelector from '../components/CountryCodeSelector';
import countryCodes from '../jsonFile/countryCodes.json';
import { useDispatch, useSelector } from 'react-redux';
import { generateOtpAction } from '../Redux/Reducer/Auth/Auth.reducer';
import { APP_TAG_NAME } from '@env';

const { width: SCREEN_W } = Dimensions.get('window');

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

// Stacked-bands gradient — replaces LinearGradient (no extra dep)
function HeroHalo({ color }) {
  const BANDS = 12;
  return (
    <View pointerEvents="none" style={styles.heroHalo}>
      {Array.from({ length: BANDS }).map((_, i) => {
        const t = (BANDS - i) / BANDS;
        const alpha = (t * t * 0.18).toFixed(3);
        return (
          <View
            key={i}
            style={[
              styles.heroHaloBand,
              {
                backgroundColor: color,
                opacity: Number(alpha),
                transform: [{ scale: 1 + i * 0.06 }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

export default function Login({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  useDeviceInfo();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const focusAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { isLoading } = useSelector(state => state.authentication);
  const [selectedCountry, setSelectedCountry] = useState(countryCodes[0]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  useEffect(() => {
    Animated.timing(focusAnim, {
      toValue: focused ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [focused]);

  const handleGenerateOtp = async () => {
    if (phoneNumber.trim().length < 10) {
      showToast('Please enter a valid number');
      return;
    }
    const fullPhoneNumber = `${selectedCountry.code}${phoneNumber}`;
    const result = await dispatch(generateOtpAction(fullPhoneNumber));
    if (generateOtpAction.fulfilled.match(result)) {
      const data = result.payload?.otpData;
      const otp = data?.otp || data?.code || data;
      navigation.navigate('Otp', { selectedCountry, phoneNumber, generatedOtp: otp });
      setPhoneNumber('');
    } else {
      showToast('Failed to generate OTP. Please try again.');
    }
  };

  const isValid = phoneNumber.length >= 10 && phoneNumber.length <= 15;
  const themeColor = theme.colors.themeColor;
  const bg = isDarkMode ? '#0B141A' : '#F4F6F9';
  const card = isDarkMode ? '#16222C' : '#FFFFFF';
  const subText = theme.colors.placeHolderTextColor;
  const primaryText = theme.colors.primaryTextColor;
  const inputBg = isDarkMode ? '#1F2C36' : '#F6F8FB';
  const inputBorderIdle = isDarkMode ? '#243340' : '#E6EAF0';
  const borderColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [inputBorderIdle, themeColor],
  });

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <HeroHalo color={themeColor} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            style={[
              styles.content,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            {/* Brand mark */}
            <View style={styles.brandWrap}>
              <View style={[styles.brandRing, { borderColor: themeColor + '22' }]}>
                <View style={[styles.brandRing2, { borderColor: themeColor + '38' }]}>
                  <View style={[styles.brandBadge, { backgroundColor: themeColor + '18' }]}>
                    <Image
                      source={require('../../assets/icon0.png')}
                      resizeMode="cover"
                      style={styles.brandLogo}
                    />
                  </View>
                </View>
              </View>
            </View>

            {/* Title */}
            <Text style={[styles.eyebrow, { color: themeColor }]}>WELCOME TO {String(APP_TAG_NAME || '').toUpperCase()}</Text>
            <Text style={[styles.title, { color: primaryText }]}>Enter your{'\n'}phone number</Text>
            <Text style={[styles.subtitle, { color: subText }]}>
              We'll send a one-time code to verify it's really you.
            </Text>

            {/* Phone Card */}
            <View style={[styles.card, { backgroundColor: card, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
              <Text style={[styles.label, { color: subText }]}>PHONE NUMBER</Text>

              <Animated.View style={[styles.inputRow, { backgroundColor: inputBg, borderColor }]}>
                <Text style={[styles.dialCode, { color: primaryText }]}>{selectedCountry?.code}</Text>

                <View style={styles.ccWrap}>
                  <CountryCodeSelector
                    selectedCountry={selectedCountry}
                    onCountrySelect={setSelectedCountry}
                    showFlag={false}
                    showCode={false}
                    showName={false}
                  />
                </View>

                <View style={[styles.ccDivider, { backgroundColor: inputBorderIdle }]} />

                <TextInput
                  style={[styles.input, { color: primaryText }]}
                  placeholder="Phone number"
                  value={phoneNumber}
                  onChangeText={(t) => setPhoneNumber(t.replace(/[^0-9]/g, ''))}
                  placeholderTextColor={subText}
                  keyboardType="phone-pad"
                  maxLength={15}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                />
              </Animated.View>

              <View style={styles.helperRow}>
                <Ionicons name="lock-closed" size={12} color={subText} />
                <Text style={[styles.helperText, { color: subText }]}>
                  Your number is encrypted and never shared.
                </Text>
              </View>
            </View>

            {/* Continue button */}
            <TouchableOpacity
              onPress={handleGenerateOtp}
              disabled={!isValid || isLoading}
              activeOpacity={0.85}
              style={[
                styles.cta,
                { backgroundColor: isValid ? themeColor : themeColor + '55' },
              ]}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Text style={styles.ctaText}>Send code</Text>
                  <Ionicons name="arrow-forward" size={18} color="#fff" />
                </>
              )}
            </TouchableOpacity>

            {/* Email alt */}
            <TouchableOpacity
              onPress={() => navigation?.navigate?.('LoginEmail')}
              activeOpacity={0.7}
              style={styles.altRow}
            >
              <Text style={[styles.altText, { color: subText }]}>Prefer email? </Text>
              <Text style={[styles.altLink, { color: themeColor }]}>Sign in with email</Text>
            </TouchableOpacity>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Footer fineprint */}
      <Animated.Text style={[styles.footer, { color: subText, opacity: fadeAnim }]}>
        By continuing, you agree to our Terms & Privacy
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 24 },
  content: { flex: 1, justifyContent: 'center' },

  // Hero halo
  heroHalo: {
    position: 'absolute',
    top: -SCREEN_W * 0.5,
    left: -SCREEN_W * 0.25,
    width: SCREEN_W * 1.5,
    height: SCREEN_W * 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroHaloBand: {
    position: 'absolute',
    width: SCREEN_W,
    height: SCREEN_W,
    borderRadius: SCREEN_W / 2,
  },

  // Brand
  brandWrap: { alignItems: 'center', marginBottom: 28 },
  brandRing: {
    width: 108, height: 108, borderRadius: 54,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  brandRing2: {
    width: 88, height: 88, borderRadius: 44,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  brandBadge: {
    width: 68, height: 68, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  brandLogo: { width: 52, height: 52, borderRadius: 14 },

  eyebrow: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 2,
    textAlign: 'center',
    marginBottom: 10,
  },
  title: {
    fontFamily: 'Roboto-Bold',
    fontSize: 28,
    lineHeight: 34,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 28,
    paddingHorizontal: 20,
    lineHeight: 20,
  },

  // Card
  card: {
    borderRadius: 22,
    padding: 18,
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 4,
  },
  label: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 10,
    marginLeft: 4,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    borderRadius: 14,
    borderWidth: 1.5,
    paddingHorizontal: 6,
  },
  ccWrap: { paddingLeft: 0 },
  ccDivider: { width: 1, height: 28, marginHorizontal: 10 },
  dialCode: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    marginLeft: 8,
    marginRight: 2,
  },
  input: {
    flex: 1,
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    letterSpacing: 1,
    paddingVertical: 0,
    paddingRight: 12,
  },
  helperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  helperText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
  },

  // CTA
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 54,
    borderRadius: 16,
    marginTop: 22,
  },
  ctaText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    letterSpacing: 0.3,
  },

  // Alt
  altRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 22,
  },
  altText: { fontFamily: 'Roboto-Regular', fontSize: 13 },
  altLink: { fontFamily: 'Roboto-SemiBold', fontSize: 13 },

  // Footer
  footer: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    textAlign: 'center',
    paddingBottom: 18,
    paddingHorizontal: 30,
  },
});
