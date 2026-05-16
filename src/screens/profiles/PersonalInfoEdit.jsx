import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  View, Text, Animated, TouchableOpacity, Alert, Platform, ToastAndroid,
  ActivityIndicator, TextInput, StyleSheet,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { editProfile, profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { FontAwesome6, Ionicons } from '@expo/vector-icons';

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

const FIELD_META = {
  fullName: {
    title: 'Name',
    placeholder: 'Your name',
    icon: 'person-outline',
    keyboard: 'default',
    maxLength: 60,
    helper: 'This name will be visible to your contacts.',
  },
  about: {
    title: 'About',
    placeholder: 'Hey there! I am using the app.',
    icon: 'information-circle-outline',
    keyboard: 'default',
    maxLength: 140,
    helper: 'Tell others a bit about yourself.',
  },
  email: {
    title: 'Email',
    placeholder: 'name@example.com',
    icon: 'mail-outline',
    keyboard: 'email-address',
    maxLength: 80,
    helper: 'We use email for account recovery and security alerts.',
  },
  mobile: {
    title: 'Mobile number',
    placeholder: 'Mobile number',
    icon: 'call-outline',
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
  const dispatch = useDispatch();
  const { profileData, isLoading } = useSelector(state => state.profile);

  const [inputValue, setInputValue] = useState(value || "");
  const [focused, setFocused] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const charCount = inputValue.length;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
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

  const pageBg = isDarkMode ? '#0f1923' : '#F4F5F7';
  const cardBg = isDarkMode ? '#172533' : '#FFFFFF';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor || '#1DA1F2';
  const showCharCount = field !== 'email' && field !== 'mobile';

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: pageBg }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: pageBg, borderBottomColor: borderClr }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconBtn} activeOpacity={0.6}>
          <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>
          Edit {meta.title}
        </Text>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!isValid || isLoading}
          activeOpacity={0.7}
          style={styles.saveBtn}
        >
          {isLoading ? (
            <ActivityIndicator size="small" color={themeColor} />
          ) : (
            <Text style={[styles.saveBtnText, { color: isValid ? themeColor : subText }]}>
              Save
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Body */}
      <View style={{ flex: 1, paddingTop: 18 }}>
        <View style={[styles.inputCard, { backgroundColor: cardBg }]}>
          <View style={[styles.iconBubble, { backgroundColor: themeColor + '18' }]}>
            <Ionicons name={meta.icon} size={20} color={themeColor} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.fieldLabel, { color: focused ? themeColor : subText }]}>
              {meta.title}
            </Text>
            {field === 'mobile' && extra?.code ? (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.codePrefix, { color: primaryText }]}>{extra.code}</Text>
                <TextInput
                  value={inputValue}
                  onChangeText={handleChange}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  placeholder={meta.placeholder}
                  placeholderTextColor={subText}
                  keyboardType={meta.keyboard}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.input, { color: primaryText, flex: 1 }]}
                />
              </View>
            ) : (
              <TextInput
                value={inputValue}
                onChangeText={handleChange}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={meta.placeholder}
                placeholderTextColor={subText}
                keyboardType={meta.keyboard}
                autoCapitalize={field === 'email' ? 'none' : 'sentences'}
                autoCorrect={field !== 'email'}
                style={[styles.input, { color: primaryText }]}
                autoFocus
              />
            )}
          </View>
        </View>

        {showCharCount && (
          <Text style={[styles.charCount, { color: subText }]}>
            {charCount}/{meta.maxLength}
          </Text>
        )}

        {errorMsg ? (
          <Text style={styles.errorText}>{errorMsg}</Text>
        ) : (
          <Text style={[styles.helperText, { color: subText }]}>{meta.helper}</Text>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: {
    width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20,
  },
  headerTitle: { flex: 1, fontFamily: 'Roboto-SemiBold', fontSize: 17, marginLeft: 4 },
  saveBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  saveBtnText: { fontFamily: 'Roboto-SemiBold', fontSize: 15 },

  inputCard: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 12, padding: 14, borderRadius: 14, gap: 12,
  },
  iconBubble: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  fieldLabel: { fontFamily: 'Roboto-Medium', fontSize: 11, letterSpacing: 0.4, marginBottom: 2 },
  input: { fontFamily: 'Roboto-Medium', fontSize: 16, padding: 0, paddingVertical: 4 },
  codePrefix: { fontFamily: 'Roboto-Medium', fontSize: 16, marginRight: 6 },
  charCount: {
    alignSelf: 'flex-end', marginTop: 8, marginRight: 18,
    fontFamily: 'Roboto-Regular', fontSize: 12,
  },
  helperText: {
    fontFamily: 'Roboto-Regular', fontSize: 12,
    marginTop: 10, marginHorizontal: 22,
  },
  errorText: {
    color: '#FF3B30', fontFamily: 'Roboto-Regular', fontSize: 12,
    marginTop: 10, marginHorizontal: 22,
  },
});
