import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, Image, Animated, TouchableOpacity, ScrollView,
  Alert, Platform, ToastAndroid, ActivityIndicator, TextInput,
  StatusBar, Dimensions, StyleSheet, KeyboardAvoidingView,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import * as ImagePicker from 'expo-image-picker';
import { editProfile, profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { BACKEND_URL } from '@env';
import { Feather, FontAwesome5, Ionicons, FontAwesome6 } from '@expo/vector-icons';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = Math.min(SCREEN_W * 0.7, 320);

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

function HeroGradient() {
  const BANDS = 14;
  const TOTAL = 180;
  const bandH = TOTAL / BANDS;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }}>
      {Array.from({ length: BANDS }).map((_, i) => {
        const t = (i + 1) / BANDS;
        const alpha = Math.min(0.6, t * t * 0.7);
        return <View key={i} style={{ height: bandH, backgroundColor: `rgba(0,0,0,${alpha.toFixed(3)})` }} />;
      })}
    </View>
  );
}

export default function EditProfile({ navigation, route }) {
  const { selectedCountry, phoneNumber, email } = route.params || {};
  const { theme, isDarkMode } = useTheme();
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

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
  }, []);

  const handleChange = (name, value) => {
    setForm(prev => ({ ...prev, [name]: value }));
    if (formErrors[name]) setFormErrors(prev => ({ ...prev, [name]: null }));
  };

  const validateForm = () => {
    const newErrors = {};
    if (!form.fullName?.trim()) newErrors.fullName = 'Full Name is required';
    if (phoneNumber !== undefined && !phoneNumber?.trim()) newErrors.phoneNumber = 'Phone number is required';
    setFormErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const requestPermission = async () => {
    if (Platform.OS === 'web') return true;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Camera roll permission is required.');
      return false;
    }
    return true;
  };

  const pickImage = async () => {
    if (!(await requestPermission())) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
    }
  };

  const showImagePickerOptions = () => {
    Alert.alert('Profile Picture', 'Choose an option', [
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
      ...(phoneNumber ? { mobile: { code: selectedCountry?.code || '', number: phoneNumber || '' } } : {}),
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

  // ─── Theme helpers ─────────────────────────
  const pageBg = isDarkMode ? '#0f1923' : '#F4F5F7';
  const cardBg = isDarkMode ? '#172533' : '#FFFFFF';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor || '#1DA1F2';
  const inputBg = isDarkMode ? '#0f1923' : '#F4F5F7';

  const imgSrc = getImageSource();

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: pageBg }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={isDarkMode ? 'light-content' : 'dark-content'} />

      {/* Floating back button */}
      <SafeAreaView edges={['top']} style={styles.topBarSafe}>
        <View style={styles.topBarRow}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.floatingBtn} activeOpacity={0.7}>
            <FontAwesome6 name="arrow-left" size={18} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Edit Profile</Text>
          <View style={{ width: 40 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
          {/* ─── Hero ─── */}
          <View style={[styles.hero, { backgroundColor: imgSrc ? '#000' : themeColor }]}>
            {imgSrc ? (
              <Image source={imgSrc} style={styles.heroImage} resizeMode="cover" />
            ) : (
              <View style={styles.heroFallback}>
                <FontAwesome5 name="user-alt" size={88} color="rgba(255,255,255,0.85)" />
              </View>
            )}
            <HeroGradient />

            <TouchableOpacity
              onPress={showImagePickerOptions}
              disabled={imageUploadLoader}
              activeOpacity={0.85}
              style={[styles.cameraFab, { backgroundColor: themeColor }]}
            >
              {imageUploadLoader ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="camera" size={20} color="#fff" />
              )}
            </TouchableOpacity>

            <View style={styles.heroOverlay} pointerEvents="none">
              <Text style={styles.heroName} numberOfLines={1}>
                {form.fullName || profileData?.fullName || 'Welcome'}
              </Text>
              <Text style={styles.heroStatus} numberOfLines={1}>
                Set up your profile
              </Text>
            </View>
          </View>

          {/* ─── PROFILE section ─── */}
          <Text style={[styles.sectionLabel, { color: subText }]}>PROFILE</Text>
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <FieldRow
              icon="person-outline"
              themeColor={themeColor}
              label="Full Name"
              value={form.fullName}
              onChangeText={(v) => handleChange('fullName', v)}
              focused={focusedInput === 'fullName'}
              onFocus={() => setFocusedInput('fullName')}
              onBlur={() => setFocusedInput(null)}
              primaryText={primaryText}
              subText={subText}
              inputBg={inputBg}
              borderClr={borderClr}
              error={formErrors.fullName}
            />

            <View style={[styles.divider, { backgroundColor: borderClr }]} />

            <FieldRow
              icon="information-circle-outline"
              themeColor={themeColor}
              label="About"
              value={form.about}
              onChangeText={(v) => handleChange('about', v)}
              focused={focusedInput === 'about'}
              onFocus={() => setFocusedInput('about')}
              onBlur={() => setFocusedInput(null)}
              primaryText={primaryText}
              subText={subText}
              inputBg={inputBg}
              borderClr={borderClr}
              error={formErrors.about}
            />
          </View>

          <Text style={[styles.helperText, { color: subText }]}>
            Your profile is visible to people you chat with on baatcheet.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Save FAB */}
      <TouchableOpacity
        onPress={handleUpdateProfile}
        disabled={isLoading || imageUploadLoader}
        activeOpacity={0.85}
        style={[
          styles.saveFab,
          {
            backgroundColor: themeColor,
            opacity: (isLoading || imageUploadLoader) ? 0.6 : 1,
          },
        ]}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Feather name="check" size={26} color="#fff" />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Field row ───
function FieldRow({
  icon, themeColor, label, value, onChangeText, focused, onFocus, onBlur,
  primaryText, subText, inputBg, borderClr, editable = true, keyboardType, error,
}) {
  return (
    <View style={styles.fieldWrap}>
      <View style={styles.fieldRow}>
        <View style={[styles.rowIcon, { backgroundColor: themeColor + '18' }]}>
          <Ionicons name={icon} size={18} color={themeColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.fieldLabel, { color: subText }]}>{label}</Text>
          <TextInput
            value={value}
            onChangeText={onChangeText}
            onFocus={onFocus}
            onBlur={onBlur}
            editable={editable}
            keyboardType={keyboardType}
            placeholder={`Enter ${label.toLowerCase()}`}
            placeholderTextColor={subText}
            style={[
              styles.fieldInput,
              {
                color: editable ? primaryText : subText,
                borderColor: focused ? themeColor : 'transparent',
                backgroundColor: focused ? inputBg : 'transparent',
              },
            ]}
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  topBarSafe: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100 },
  topBarRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6,
  },
  floatingBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  topBarTitle: {
    flex: 1, textAlign: 'center', color: '#fff',
    fontFamily: 'Roboto-SemiBold', fontSize: 16,
    textShadowColor: 'rgba(0,0,0,0.4)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },

  hero: { width: '100%', height: HERO_H, position: 'relative', overflow: 'hidden' },
  heroImage: { width: '100%', height: '100%' },
  heroFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroOverlay: { position: 'absolute', left: 20, right: 80, bottom: 18 },
  heroName: {
    color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 24,
    textShadowColor: 'rgba(0,0,0,0.4)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  heroStatus: {
    color: 'rgba(255,255,255,0.85)', fontFamily: 'Roboto-Regular', fontSize: 13, marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.4)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  cameraFab: {
    position: 'absolute', right: 18, bottom: 18,
    width: 50, height: 50, borderRadius: 25,
    alignItems: 'center', justifyContent: 'center',
    elevation: 5,
    shadowColor: '#000', shadowOpacity: 0.3, shadowOffset: { width: 0, height: 2 }, shadowRadius: 4,
  },

  sectionLabel: {
    fontFamily: 'Roboto-Medium', fontSize: 11, letterSpacing: 0.8,
    marginTop: 18, marginBottom: 6, paddingHorizontal: 24,
  },
  card: { marginHorizontal: 12, borderRadius: 14, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 64 },

  fieldWrap: { paddingVertical: 8 },
  fieldRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: 8, paddingHorizontal: 14, gap: 14,
  },
  rowIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 6,
  },
  fieldLabel: { fontFamily: 'Roboto-Regular', fontSize: 12 },
  fieldInput: {
    marginTop: 2, paddingVertical: 8, paddingHorizontal: 8,
    fontFamily: 'Roboto-Medium', fontSize: 15,
    borderRadius: 8, borderWidth: 1,
  },
  errorText: { color: '#E53935', fontFamily: 'Roboto-Medium', fontSize: 12, marginTop: 4 },

  helperText: {
    fontFamily: 'Roboto-Regular', fontSize: 12,
    paddingHorizontal: 24, marginTop: 14, textAlign: 'center',
  },

  saveFab: {
    position: 'absolute', bottom: 24, right: 20,
    width: 58, height: 58, borderRadius: 29,
    alignItems: 'center', justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000', shadowOpacity: 0.3, shadowOffset: { width: 0, height: 2 }, shadowRadius: 5,
  },
});
