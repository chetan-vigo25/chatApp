import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  View, Text, Image, Animated, TouchableOpacity, ScrollView,
  Alert, Platform, ToastAndroid, ActivityIndicator, TextInput,
  StatusBar, StyleSheet, KeyboardAvoidingView,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import * as ImagePicker from 'expo-image-picker';
import { suspendAppLock, resumeAppLock } from "../../services/appLockGuard";
import { ensurePermission, PERMISSION_IDS } from "../../features/permissions/ensurePermission";
import { editProfile, profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { BACKEND_URL } from '@env';
import { Feather, Ionicons } from '@expo/vector-icons';

const NAME_MAX = 25;
const ABOUT_MAX = 139;
const AVATAR = 116;

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

// Brand-teal header wash. Stacked 1px bands instead of expo-linear-gradient so
// there is no native dependency/rebuild; a low band count shows visible strips.
function HeaderWash({ height, color }) {
  const BANDS = 90;
  const bandH = height / BANDS;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: BANDS }).map((_, i) => {
        const t = i / (BANDS - 1);
        // Fade the accent out toward the bottom so it lands on the page bg.
        const alpha = (1 - t) * (1 - t);
        return <View key={i} style={{ height: bandH, backgroundColor: color, opacity: alpha }} />;
      })}
    </View>
  );
}

export default function EditProfile({ navigation, route }) {
  const { selectedCountry, phoneNumber, email } = route.params || {};
  const { theme, isDarkMode } = useTheme();
  const insets = useSafeAreaInsets();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [focusedInput, setFocusedInput] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageUploadLoader, setImageUploadLoader] = useState(false);
  const dispatch = useDispatch();
  const { profileData, isLoading } = useSelector(state => state.profile);

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    about: '',
    profileImage: '',
  });

  const getUploadedImageUrl = (result = {}) => (
    result?.data?.profileImageUrl ||
    result?.data?.profileImage ||
    result?.data?.url ||
    result?.profileImageUrl ||
    result?.profileImage ||
    ''
  );

  useEffect(() => {
    if (!profileData) dispatch(profileDetail());
  }, []);

  // Seed the form from the server profile once it lands — without this the
  // fields render empty on an edit and a blind save wipes the stored values.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!profileData || seededRef.current) return;
    seededRef.current = true;
    setForm(prev => ({
      fullName: prev.fullName || profileData.fullName || '',
      email: prev.email || profileData.email || '',
      about: prev.about || profileData.about || '',
      profileImage: prev.profileImage || profileData.profileImage || '',
    }));
  }, [profileData]);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
  }, []);

  const handleChange = (name, value) => {
    setForm(prev => ({ ...prev, [name]: value }));
    if (formErrors[name]) setFormErrors(prev => ({ ...prev, [name]: null }));
  };

  const validateForm = () => {
    const newErrors = {};
    if (!form.fullName?.trim()) newErrors.fullName = 'Full name is required';
    if (phoneNumber !== undefined && !phoneNumber?.trim()) newErrors.phoneNumber = 'Phone number is required';
    // A number without its country code is ambiguous — the same digits are a
    // different phone number in a different country — so the server rejects the
    // pair. Catch it here instead of surfacing a server validation error.
    if (phoneNumber?.trim() && !selectedCountry?.code) {
      newErrors.phoneNumber = 'Country code is required with the phone number';
    }
    setFormErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const requestPermission = async () => {
    if (Platform.OS === 'web') return true;
    // Shared in-context gate: re-asks the OS if photos was denied at startup, and
    // routes to Settings once the OS will no longer show its dialog.
    return ensurePermission(PERMISSION_IDS.PHOTOS, {
      purpose: 'Allow access to your photos to choose a profile picture.',
    });
  };

  const pickImage = async () => {
    if (!(await requestPermission())) return;
    // The gallery picker backgrounds the app; suspend the app lock for the round trip.
    suspendAppLock();
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setSelectedImage(result.assets[0].uri);
      }
    } catch (e) {
      console.error('pickImage', e);
      showToast('Failed to pick image');
    } finally {
      resumeAppLock();
    }
  };

  const showImagePickerOptions = () => {
    Alert.alert('Profile Photo', 'Choose an option', [
      { text: 'Choose from Gallery', onPress: pickImage },
      { text: 'Cancel', style: 'cancel' },
    ], { cancelable: true });
  };

  const imageEdit = async ({ silent = false } = {}) => {
    if (!selectedImage) {
      if (!silent) showToast('No image selected');
      return null;
    }
    setImageUploadLoader(true);
    try {
      const token = await AsyncStorage.getItem("accessToken");
      const ext = selectedImage.split('.').pop();
      const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
      const formData = new FormData();
      formData.append("file", { uri: selectedImage, name: `profile.${ext}`, type: mime });

      const response = await fetch(`${BACKEND_URL}user/profile/picture`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body: formData,
      });
      const result = await response.json();

      if (result?.statusCode === 200) {
        const uploadedImageUrl = getUploadedImageUrl(result);
        if (!uploadedImageUrl) throw new Error('Uploaded image URL not found');
        if (!silent) showToast("Profile image updated");
        dispatch(profileDetail());
        setSelectedImage(null);
        setForm(prev => ({ ...prev, profileImage: uploadedImageUrl }));
        return uploadedImageUrl;
      }
      if (!silent) showToast(result?.message || "Image upload failed");
      return null;
    } catch (e) {
      console.error(e);
      if (!silent) showToast(e?.message || "Network request failed");
      return null;
    } finally {
      setImageUploadLoader(false);
    }
  };

  const getImageSource = () => {
    if (selectedImage) return { uri: selectedImage };
    if (profileData?.profileImage) return { uri: profileData.profileImage };
    return null;
  };

  const handleUpdateProfile = async () => {
    if (!validateForm()) return;
    let finalProfileImage = form.profileImage || profileData?.profileImage || '';

    if (selectedImage) {
      const uploadedImageUrl = await imageEdit({ silent: true });
      if (!uploadedImageUrl) {
        showToast('Please upload profile image again');
        return;
      }
      finalProfileImage = uploadedImageUrl;
    }

    const payload = {
      fullName: form.fullName,
      email: form.email || email || '',
      about: form.about,
      profileImage: finalProfileImage,
      // Send the country code and national number together — never a dangling
      // one. The pair is what identifies the number server-side.
      ...(phoneNumber?.trim() && selectedCountry?.code
        ? { mobile: { code: selectedCountry.code, number: phoneNumber.trim() } }
        : {}),
    };

    try {
      await dispatch(editProfile(payload)).unwrap();
      showToast("Profile updated successfully");
      dispatch(profileDetail());
      navigation.reset({ index: 0, routes: [{ name: "ChatList" }] });
    } catch (e) {
      console.error(e);
      showToast(e?.message || "Profile update failed");
    }
  };

  // ─── Theme tokens ─────────────────────────
  const c = theme.colors;
  const themeColor = c.themeColor || '#03b0a2';
  // Dark mode paints a deep near-black page so the card reads as the only lit
  // surface; the card itself stays a shade above it and the inputs a shade above
  // the card (page < card < input) so the field boxes are visible without borders
  // doing all the work.
  const pageBg = isDarkMode ? '#050B0F' : c.background;
  const cardBg = isDarkMode ? '#0F1A21' : '#FFFFFF';
  const inputBg = isDarkMode ? '#16232C' : '#F4F5F7';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
  const inputBorder = isDarkMode ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)';
  const primaryText = c.primaryTextColor;
  const subText = c.secondaryTextColor;

  const imgSrc = getImageSource();
  const headerTop = insets.top + 8;
  const washH = headerTop + 200;

  const displayNumber = useMemo(() => {
    const code = selectedCountry?.code || profileData?.mobile?.code || '';
    const num = phoneNumber || profileData?.mobile?.number || profileData?.userName || '';
    return num ? `${code ? `${code} ` : ''}${num}` : '';
  }, [selectedCountry, phoneNumber, profileData]);

  const busy = isLoading || imageUploadLoader;
  const canSave = !!form.fullName?.trim() && !busy;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: pageBg }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <HeaderWash height={washH} color={themeColor} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 32 }}
        >
          {/* ─── Header ─── */}
          <View style={[styles.header, { paddingTop: headerTop }]}>
            <Text style={styles.headerTitle}>Edit Profile</Text>
            <Text style={styles.headerSubtitle}>
              Add a photo and a name so people know it's you
            </Text>

            {/* Avatar + camera badge */}
            <TouchableOpacity
              onPress={showImagePickerOptions}
              disabled={imageUploadLoader}
              activeOpacity={0.85}
              style={styles.avatarWrap}
            >
              <View style={[styles.avatarRing, { borderColor: 'rgba(255,255,255,0.55)' }]}>
                {imgSrc ? (
                  <Image source={imgSrc} style={styles.avatarImg} resizeMode="cover" />
                ) : (
                  <View style={[styles.avatarImg, styles.avatarFallback]}>
                    <Ionicons name="person" size={54} color="rgba(255,255,255,0.9)" />
                  </View>
                )}
              </View>

              <View style={[styles.cameraBadge, { backgroundColor: '#fff', borderColor: pageBg }]}>
                {imageUploadLoader
                  ? <ActivityIndicator size="small" color={themeColor} />
                  : <Ionicons name="camera" size={18} color={themeColor} />}
              </View>
            </TouchableOpacity>

            {!!displayNumber && (
              <Text style={styles.headerNumber} numberOfLines={1}>{displayNumber}</Text>
            )}
          </View>

          {/* ─── Form ─── */}
          <Text style={[styles.sectionLabel, { color: subText }]}>PROFILE</Text>
          <View style={[styles.card, { backgroundColor: cardBg, borderColor: borderClr }]}>
            <Field
              icon="person-outline"
              label="Full name"
              placeholder="Your name"
              value={form.fullName}
              onChangeText={(v) => handleChange('fullName', v.slice(0, NAME_MAX))}
              focused={focusedInput === 'fullName'}
              onFocus={() => setFocusedInput('fullName')}
              onBlur={() => setFocusedInput(null)}
              counter={`${form.fullName.length}/${NAME_MAX}`}
              error={formErrors.fullName}
              autoCapitalize="words"
              returnKeyType="next"
              {...{ themeColor, primaryText, subText, inputBg, borderClr, inputBorder }}
            />

            <Field
              icon="information-circle-outline"
              label="About"
              placeholder="Hey there! I am using TalksTry."
              value={form.about}
              onChangeText={(v) => handleChange('about', v.slice(0, ABOUT_MAX))}
              focused={focusedInput === 'about'}
              onFocus={() => setFocusedInput('about')}
              onBlur={() => setFocusedInput(null)}
              counter={`${form.about.length}/${ABOUT_MAX}`}
              error={formErrors.about}
              multiline
              {...{ themeColor, primaryText, subText, inputBg, borderClr, inputBorder }}
            />
          </View>

          <View style={styles.helperRow}>
            <Ionicons name="lock-closed-outline" size={13} color={subText} style={{ marginTop: 1 }} />
            <Text style={[styles.helperText, { color: subText }]}>
              Your name and photo are visible to people you chat with on TalksTry.
            </Text>
          </View>
        </ScrollView>

        {/* ─── Save bar ─── */}
        <View style={[
          styles.saveBar,
          { backgroundColor: pageBg, borderTopColor: borderClr, paddingBottom: Math.max(insets.bottom, 12) },
        ]}>
          <TouchableOpacity
            onPress={handleUpdateProfile}
            disabled={!canSave}
            activeOpacity={0.85}
            style={[styles.saveBtn, { backgroundColor: themeColor, opacity: canSave ? 1 : 0.45 }]}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Feather name="check" size={18} color="#fff" />
                <Text style={styles.saveBtnText}>Save Profile</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

// ─── Field ───
function Field({
  icon, themeColor, label, placeholder, value, onChangeText, focused, onFocus, onBlur,
  primaryText, subText, inputBg, borderClr, inputBorder, editable = true, keyboardType, error,
  counter, multiline, autoCapitalize, returnKeyType,
}) {
  const accent = error ? '#E53935' : themeColor;
  return (
    <View style={styles.fieldWrap}>
      <View style={styles.fieldHead}>
        <View style={[styles.rowIcon, { backgroundColor: accent + '1A' }]}>
          <Ionicons name={icon} size={16} color={accent} />
        </View>
        <Text style={[styles.fieldLabel, { color: focused ? accent : subText }]}>{label}</Text>
        {!!counter && <Text style={[styles.counter, { color: subText }]}>{counter}</Text>}
      </View>

      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        editable={editable}
        keyboardType={keyboardType}
        multiline={multiline}
        autoCapitalize={autoCapitalize}
        returnKeyType={returnKeyType}
        placeholder={placeholder}
        placeholderTextColor={subText}
        style={[
          styles.fieldInput,
          focused && styles.fieldInputFocused,
          multiline && styles.fieldInputMultiline,
          {
            color: editable ? primaryText : subText,
            borderColor: error ? '#E53935' : (focused ? themeColor : inputBorder),
            backgroundColor: inputBg,
          },
        ]}
      />

      {error ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle" size={13} color="#E53935" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: { alignItems: 'center', paddingHorizontal: 24, paddingBottom: 6 },
  headerTitle: {
    color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 20, letterSpacing: 0.2,
  },
  headerSubtitle: {
    color: 'rgba(255,255,255,0.82)', fontFamily: 'Roboto-Regular', fontSize: 13,
    marginTop: 6, textAlign: 'center', lineHeight: 18,
  },

  avatarWrap: { marginTop: 22, width: AVATAR, height: AVATAR },
  avatarRing: {
    width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2,
    borderWidth: 3, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  cameraBadge: {
    position: 'absolute', right: -2, bottom: -2,
    width: 36, height: 36, borderRadius: 18, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000', shadowOpacity: 0.25, shadowOffset: { width: 0, height: 2 }, shadowRadius: 4,
  },
  headerNumber: {
    color: '#fff', fontFamily: 'Roboto-Medium', fontSize: 16, marginTop: 14,
  },

  sectionLabel: {
    fontFamily: 'Roboto-Medium', fontSize: 11, letterSpacing: 1,
    marginTop: 26, marginBottom: 8, paddingHorizontal: 24,
  },
  card: {
    marginHorizontal: 16, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16, paddingVertical: 6, gap: 4,
  },

  fieldWrap: { paddingVertical: 12 },
  fieldHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  rowIcon: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  fieldLabel: { flex: 1, fontFamily: 'Roboto-Medium', fontSize: 13 },
  counter: { fontFamily: 'Roboto-Regular', fontSize: 11 },
  fieldInput: {
    paddingVertical: 13, paddingHorizontal: 14,
    fontFamily: 'Roboto-Regular', fontSize: 15,
    borderRadius: 12, borderWidth: 1,
  },
  fieldInputFocused: { borderWidth: 1.5 },
  fieldInputMultiline: { minHeight: 78, textAlignVertical: 'top' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  errorText: { color: '#E53935', fontFamily: 'Roboto-Regular', fontSize: 12 },

  helperRow: {
    flexDirection: 'row', gap: 7, alignItems: 'flex-start',
    paddingHorizontal: 26, marginTop: 16,
  },
  helperText: { flex: 1, fontFamily: 'Roboto-Regular', fontSize: 12, lineHeight: 17 },

  saveBar: {
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  saveBtn: {
    height: 52, borderRadius: 26, flexDirection: 'row', gap: 8,
    alignItems: 'center', justifyContent: 'center',
    elevation: 3,
    shadowColor: '#000', shadowOpacity: 0.2, shadowOffset: { width: 0, height: 2 }, shadowRadius: 5,
  },
  saveBtnText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 16 },
});
