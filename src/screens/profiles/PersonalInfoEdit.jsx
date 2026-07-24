import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  View, Text, Animated, TouchableOpacity, Alert, Platform, ToastAndroid,
  ActivityIndicator, TextInput, StyleSheet, KeyboardAvoidingView,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { editProfile, profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

const FIELD_META = {
  fullName: {
    title: 'Name',
    placeholder: 'Your name',
    keyboard: 'default',
    maxLength: 60,
    helper: 'This name will be visible to your contacts.',
  },
  about: {
    title: 'About',
    placeholder: 'Hey there! I am using the app.',
    keyboard: 'default',
    maxLength: 140,
    helper: 'Add a few words about yourself.',
  },
  email: {
    title: 'Email',
    placeholder: 'name@example.com',
    keyboard: 'email-address',
    maxLength: 80,
    helper: 'We use email for account recovery and security alerts.',
  },
  mobile: {
    title: 'Mobile number',
    placeholder: 'Mobile number',
    keyboard: 'phone-pad',
    maxLength: 15,
    helper: 'Changing your number will require verification.',
  },
};

const validateEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const validateMobile = (v) => /^[0-9]{6,15}$/.test(String(v).replace(/[^\d]/g, ''));

export default function PersonalInfoEdit({ navigation, route }) {
  const { field, value, extra } = route.params || {};
  const meta = FIELD_META[field] || FIELD_META.fullName;
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const inputRef = useRef(null);
  const dispatch = useDispatch();
  const { profileData, isLoading } = useSelector(state => state.profile);

  const [inputValue, setInputValue] = useState(value || "");
  const [focused, setFocused] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const charCount = inputValue.length;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, []);

  useEffect(() => { setInputValue(value || ""); }, [value]);

  const isValid = useMemo(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return false;
    if (field === 'email') return validateEmail(trimmed);
    if (field === 'mobile') return validateMobile(trimmed);
    return true;
  }, [inputValue, field]);

  const handleSave = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed) { setErrorMsg(`${meta.title} cannot be empty.`); return; }
    if (field === 'email' && !validateEmail(trimmed)) {
      setErrorMsg('Enter a valid email address.');
      return;
    }
    if (field === 'mobile' && !validateMobile(trimmed)) {
      setErrorMsg('Enter a valid mobile number.');
      return;
    }

    let updatedData;
    if (field === 'mobile') {
      updatedData = {
        ...profileData,
        mobile: {
          ...(profileData?.mobile || {}),
          code: extra?.code || profileData?.mobile?.code || '+91',
          number: trimmed.replace(/[^\d]/g, ''),
        },
      };
    } else {
      updatedData = { ...profileData, [field]: trimmed };
    }

    try {
      await dispatch(editProfile(updatedData));
      await dispatch(profileDetail());
      showToast(`${meta.title} updated`);
      navigation.goBack();
    } catch (err) {
      console.error('Error updating profile:', err);
      setErrorMsg('Failed to update. Try again.');
    }
  };

  const handleChange = (text) => {
    if (errorMsg) setErrorMsg(null);
    const allowed = field === 'mobile' ? text.replace(/[^\d]/g, '') : text;
    if (allowed.length <= meta.maxLength) setInputValue(allowed);
  };

  // WhatsApp dark/light surfaces, accented by the user's theme colour.
  const pageBg = isDarkMode ? '#000000' : '#FFFFFF';
  const headerBg = isDarkMode ? '#1F2C33' : theme.colors.themeColor;
  const onHeader = isDarkMode ? theme.colors.primaryTextColor : '#FFFFFF';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor || '#03b0a2';
  const underlineIdle = isDarkMode ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
  const showCharCount = field !== 'email' && field !== 'mobile';
  const remaining = meta.maxLength - charCount;
  const isMultiline = field === 'about';

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: pageBg }]}>
      {/* WhatsApp header — theme-green in light mode, dark surface in dark mode.
          The header colour fills the status-bar inset (SafeAreaView top edge). */}
      <SafeAreaView edges={['top']} style={{ backgroundColor: headerBg }}>
        <View style={[styles.header, { backgroundColor: headerBg }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconBtn} activeOpacity={0.6} hitSlop={hit}>
            <Ionicons name="arrow-back" size={23} color={onHeader} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: onHeader }]} numberOfLines={1}>
            {meta.title}
          </Text>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          {/* Underlined input row: text · counter · emoji (WhatsApp). */}
          <View style={[styles.inputRow, { borderBottomColor: focused ? themeColor : underlineIdle }]}>
            {field === 'mobile' && extra?.code ? (
              <Text style={[styles.codePrefix, { color: primaryText }]}>{extra.code}</Text>
            ) : null}
            <TextInput
              ref={inputRef}
              value={inputValue}
              onChangeText={handleChange}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={meta.placeholder}
              placeholderTextColor={subText}
              keyboardType={meta.keyboard}
              autoCapitalize={field === 'email' ? 'none' : (field === 'mobile' ? 'none' : 'sentences')}
              autoCorrect={field !== 'email' && field !== 'mobile'}
              style={[styles.input, { color: primaryText }]}
              multiline={isMultiline}
              autoFocus
              onSubmitEditing={!isMultiline ? handleSave : undefined}
              returnKeyType={!isMultiline ? 'done' : 'default'}
            />
            {showCharCount && (
              <Text style={[styles.counter, { color: remaining <= 10 ? themeColor : subText }]}>
                {remaining}
              </Text>
            )}
            <TouchableOpacity
              onPress={() => inputRef.current?.focus()}
              activeOpacity={0.6}
              hitSlop={hit}
              style={styles.emojiBtn}
            >
              <Ionicons name="happy-outline" size={22} color={subText} />
            </TouchableOpacity>
          </View>

          {errorMsg ? (
            <Text style={styles.errorText}>{errorMsg}</Text>
          ) : (
            <Text style={[styles.helperText, { color: subText }]}>{meta.helper}</Text>
          )}
        </View>

        {/* Green circular check FAB — WhatsApp's save affordance. */}
        <View style={styles.fabWrap} pointerEvents="box-none">
          <TouchableOpacity
            onPress={handleSave}
            disabled={!isValid || isLoading}
            activeOpacity={0.85}
            style={[
              styles.fab,
              { backgroundColor: themeColor, opacity: (!isValid || isLoading) ? 0.5 : 1, shadowColor: themeColor },
            ]}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="checkmark" size={28} color="#fff" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

const hit = { top: 8, bottom: 8, left: 8, right: 8 };

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 6,
    paddingTop: 8,
    paddingBottom: 14,
  },
  iconBtn: {
    width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21,
  },
  headerTitle: { flex: 1, fontFamily: 'Roboto-Medium', fontSize: 19, marginLeft: 6 },

  body: { flex: 1, paddingHorizontal: 12, paddingTop: 26 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderBottomWidth: 2,
    paddingBottom: 6,
    gap: 8,
  },
  input: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 17,
    padding: 0,
    paddingTop: Platform.OS === 'ios' ? 2 : 0,
    maxHeight: 120,
  },
  codePrefix: { fontFamily: 'Roboto-Medium', fontSize: 17, marginRight: 2 },
  counter: { fontFamily: 'Roboto-Regular', fontSize: 13, marginBottom: 2 },
  emojiBtn: { paddingLeft: 2, paddingBottom: 1 },

  helperText: {
    fontFamily: 'Roboto-Regular', fontSize: 13,
    marginTop: 14, lineHeight: 18,
  },
  errorText: {
    color: '#FF3B30', fontFamily: 'Roboto-Regular', fontSize: 13,
    marginTop: 14,
  },

  fabWrap: {
    position: 'absolute', right: 22, bottom: 26,
  },
  fab: {
    width: 58, height: 58, borderRadius: 29,
    alignItems: 'center', justifyContent: 'center',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
});
