import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet, View, Text, ActivityIndicator, Animated,
  TouchableOpacity, TextInput, Alert, Platform, ToastAndroid,
  KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import CountryCodeSelector from '../components/CountryCodeSelector';
import countryCodes from '../jsonFile/countryCodes.json';
import { useDispatch, useSelector } from 'react-redux';
import { generateOtpAction } from '../Redux/Reducer/Auth/Auth.reducer';
import { getPhoneRule, isPhoneValid, phoneLengthHint } from '../utils/phoneValidation';
import { APP_TAG_NAME } from '@env';

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

export default function Login({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  useDeviceInfo();
  const dispatch = useDispatch();
  const { isLoading } = useSelector(state => state.authentication);

  const [selectedCountry, setSelectedCountry] = useState(countryCodes[0]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneFocused, setPhoneFocused] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(14)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleCountrySelect = (country) => {
    setSelectedCountry(country);
    const { max } = getPhoneRule(country?.code);
    setPhoneNumber((prev) => prev.slice(0, max));
  };

  const handleGenerateOtp = async () => {
    if (!isValid) {
      showToast(`Enter a valid ${selectedCountry?.name || ''} number (${phoneLengthHint(selectedCountry?.code)})`.replace('  ', ' '));
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

  const phoneRule = getPhoneRule(selectedCountry?.code);
  const isValid = isPhoneValid(selectedCountry?.code, phoneNumber);
  const showLengthError = phoneNumber.length > 0 && !isValid;
  const dialCode = (selectedCountry?.code || '+1').replace('+', '');

  // WhatsApp palette
  const accent = isDarkMode ? '#00A884' : '#008069';
  const link = isDarkMode ? '#53BDEB' : '#027EB5';
  const bg = isDarkMode ? '#0B141A' : '#FFFFFF';
  const primaryText = isDarkMode ? '#E9EDEF' : '#111B21';
  const secondaryText = isDarkMode ? '#8696A0' : '#54656F';
  const placeholderText = isDarkMode ? '#5E7280' : '#A6B0BD';
  const underlineIdle = isDarkMode ? '#2A3942' : '#D1D7DB';
  const disabledBtn = isDarkMode ? '#1F2C33' : '#D8DEE2';
  const disabledTxt = isDarkMode ? '#54656F' : '#9AA6AE';

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Text style={[styles.topTitle, { color: accent }]} numberOfLines={1}>
          {String(APP_TAG_NAME || 'Verify your number')}
        </Text>
        <TouchableOpacity hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} activeOpacity={0.6}>
          <Ionicons name="ellipsis-vertical" size={20} color={secondaryText} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
            <Text style={[styles.heading, { color: primaryText }]}>Enter your phone number</Text>
            <Text style={[styles.blurb, { color: secondaryText }]}>
              {String(APP_TAG_NAME || 'We')} will need to verify your phone number.{' '}
              <Text style={[styles.link, { color: link }]}>What's my number?</Text>
            </Text>

            {/* Country selector — centered, green underline */}
            <View style={[styles.countryRow, { borderBottomColor: accent }]}>
              <CountryCodeSelector
                selectedCountry={selectedCountry}
                onCountrySelect={handleCountrySelect}
                showFlag={false}
                showCode={false}
                showName={true}
                style={styles.countrySelector}
              />
            </View>

            {/* Code + phone, aligned underlines */}
            <View style={styles.numberRow}>
              <View style={[styles.codeCell, { borderBottomColor: underlineIdle }]}>
                <Text style={[styles.plus, { color: primaryText }]}>+</Text>
                <Text style={[styles.code, { color: primaryText }]}>{dialCode}</Text>
              </View>

              <View style={[styles.phoneCell, { borderBottomColor: showLengthError ? '#E5484D' : (phoneFocused ? accent : underlineIdle) }]}>
                <TextInput
                  style={[styles.phoneInput, { color: primaryText }]}
                  placeholder="phone number"
                  placeholderTextColor={placeholderText}
                  value={phoneNumber}
                  onChangeText={(t) => setPhoneNumber(t.replace(/[^0-9]/g, '').slice(0, phoneRule.max))}
                  keyboardType="phone-pad"
                  maxLength={phoneRule.max}
                  onFocus={() => setPhoneFocused(true)}
                  onBlur={() => setPhoneFocused(false)}
                />
              </View>
            </View>

            <Text
              style={[styles.fineprint, { color: showLengthError ? '#E5484D' : secondaryText }]}
            >
              {showLengthError
                ? `${selectedCountry?.name || 'This country'} numbers are ${phoneLengthHint(selectedCountry?.code)}`
                : `Enter your ${phoneLengthHint(selectedCountry?.code)} ${selectedCountry?.name || ''} number`.trimEnd()}
            </Text>
          </Animated.View>
        </ScrollView>

        {/* Bottom actions */}
        <View style={styles.bottomArea}>
          <TouchableOpacity
            onPress={() => navigation?.navigate?.('LoginEmail')}
            activeOpacity={0.7}
            style={styles.altRow}
          >
            <Text style={[styles.altText, { color: secondaryText }]}>or </Text>
            <Text style={[styles.altLink, { color: link }]}>sign in with email</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleGenerateOtp}
            disabled={!isValid || isLoading}
            activeOpacity={0.85}
            style={[styles.nextBtn, { backgroundColor: isValid ? accent : disabledBtn }]}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={[styles.nextText, { color: isValid ? '#FFFFFF' : disabledTxt }]}>NEXT</Text>
            )}
          </TouchableOpacity>

          <Text style={[styles.terms, { color: secondaryText }]}>
            By tapping NEXT you agree to our Terms & Privacy Policy
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
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topTitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 19,
    letterSpacing: 0.15,
    flex: 1,
    marginRight: 12,
  },

  scroll: { flexGrow: 1, paddingHorizontal: 32, paddingTop: 20 },
  content: { paddingTop: 8, alignItems: 'center' },

  heading: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 14,
  },
  blurb: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 36,
  },
  link: { fontFamily: 'Roboto-Regular', fontSize: 14 },

  // Country selector
  countryRow: {
    width: '70%',
    borderBottomWidth: 2,
    marginBottom: 26,
  },
  countrySelector: {
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },

  // Number row — code + phone aligned on one baseline
  numberRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    width: '70%',
    gap: 16,
  },
  codeCell: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 64,
    height: 44,
    borderBottomWidth: 2,
  },
  plus: {
    fontFamily: 'Roboto-Medium',
    fontSize: 18,
    marginRight: 4,
  },
  code: {
    fontFamily: 'Roboto-Medium',
    fontSize: 18,
  },
  phoneCell: {
    flex: 1,
    height: 44,
    borderBottomWidth: 2,
    justifyContent: 'center',
  },
  phoneInput: {
    fontFamily: 'Roboto-Regular',
    fontSize: 18,
    letterSpacing: 0.5,
    paddingVertical: 0,
  },

  fineprint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 20,
  },

  // Bottom
  bottomArea: {
    paddingHorizontal: 32,
    paddingBottom: 28,
    paddingTop: 8,
    alignItems: 'center',
  },
  altRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  altText: { fontFamily: 'Roboto-Regular', fontSize: 13 },
  altLink: { fontFamily: 'Roboto-Medium', fontSize: 13 },

  nextBtn: {
    minWidth: 130,
    height: 46,
    paddingHorizontal: 30,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    letterSpacing: 1.3,
  },

  terms: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 16,
    paddingHorizontal: 16,
  },
});
