import React, { useState, useRef, useCallback } from "react";
import {
  View, Text, Image, Animated, TouchableOpacity, ScrollView,
  Alert, Platform, ToastAndroid, ActivityIndicator, StatusBar,
  Dimensions, StyleSheet,
} from "react-native";
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { BACKEND_URL } from '@env';
import {
  FontAwesome6, Ionicons, FontAwesome5, MaterialCommunityIcons,
} from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = Math.min(SCREEN_W, 420);

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

// Smooth dark bottom gradient using stacked thin bands
function HeroGradient() {
  const BANDS = 14;
  const TOTAL = 220;
  const bandH = TOTAL / BANDS;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }}>
      {Array.from({ length: BANDS }).map((_, i) => {
        const t = (i + 1) / BANDS;
        const alpha = Math.min(0.62, t * t * 0.7);
        return <View key={i} style={{ height: bandH, backgroundColor: `rgba(0,0,0,${alpha.toFixed(3)})` }} />;
      })}
    </View>
  );
}

export default function Profile({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const [selectedImage, setSelectedImage] = useState(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { profileData } = useSelector(state => state.profile);
  const [loader, setLoader] = useState(false);
  const scrollY = useRef(new Animated.Value(0)).current;

  const shadeOpacity = scrollY.interpolate({
    inputRange: [0, HERO_H * 0.8],
    outputRange: [0, 0.85],
    extrapolate: 'clamp',
  });

  useFocusEffect(
    useCallback(() => {
      dispatch(profileDetail());
      Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    }, [])
  );

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
        const uri = result.assets[0].uri;
        setSelectedImage(uri);
        await imageEdit(uri);
      }
    } catch (e) {
      console.error('pickImage', e);
      showToast('Failed to pick image');
    }
  };

  const imageEdit = async (uri) => {
    if (!uri) return;
    setLoader(true);
    try {
      const token = await AsyncStorage.getItem("accessToken");
      const ext = uri.split('.').pop();
      const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
      const formData = new FormData();
      formData.append("file", { uri, name: `profile.${ext}`, type: mime });

      const response = await fetch(`${BACKEND_URL}user/profile/picture`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body: formData,
      });
      const result = await response.json();
      if (result?.statusCode === 200) {
        showToast("Profile image updated");
        dispatch(profileDetail());
        setSelectedImage(null);
      } else {
        showToast(result?.message || "Image upload failed");
      }
    } catch (e) {
      console.error(e);
      showToast("Network request failed");
    } finally {
      setLoader(false);
    }
  };

  const removeDp = async () => {
    setLoader(true);
    try {
      const token = await AsyncStorage.getItem("accessToken");
      const response = await fetch(`${BACKEND_URL}user/profile/picture/remove`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
      const result = await response.json();
      if (result?.statusCode === 200) {
        showToast("Profile image removed");
        dispatch(profileDetail());
        setSelectedImage(null);
      } else {
        showToast(result?.message || "Failed to remove profile image");
      }
    } catch (e) {
      console.error(e);
      showToast("Failed to remove profile image");
    } finally {
      setLoader(false);
    }
  };

  const showImagePickerOptions = () => {
    Alert.alert('Profile Picture', 'Choose an option', [
      { text: 'Choose from Gallery', onPress: pickImage },
      ...(profileData?.profileImage ? [{ text: 'Remove Photo', style: 'destructive', onPress: removeDp }] : []),
      { text: 'Cancel', style: 'cancel' },
    ], { cancelable: true });
  };

  const imageUri = selectedImage || profileData?.profileImage || null;
  const displayName = profileData?.fullName || 'Add your name';
  const phoneNumber = profileData?.mobile?.number || '';
  const phoneCode = profileData?.mobile?.code || '';
  const displayPhone = phoneCode ? `${phoneCode} ${phoneNumber}` : phoneNumber;
  const userEmail = profileData?.email || '';
  const aboutText = profileData?.about || '';
  const userName = profileData?.userName || '';

  // ─── Theme helpers ─────────────────────────
  const pageBg = isDarkMode ? '#0f1923' : '#F4F5F7';
  const cardBg = isDarkMode ? '#172533' : '#FFFFFF';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor || '#1DA1F2';

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: pageBg }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />

      {/* Floating top bar — only back arrow, no edit icon */}
      <SafeAreaView edges={['top']} style={styles.topBarSafe}>
        <View style={styles.topBarRow}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.floatingBtn} activeOpacity={0.7}>
            <FontAwesome6 name="arrow-left" size={18} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
        </View>
      </SafeAreaView>

      {/* ─── Parallax background image with scroll shade ─── */}
      <View
        style={[styles.hero, { backgroundColor: imageUri ? '#000' : themeColor }]}
        pointerEvents="none"
      >
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.heroImage} resizeMode="cover" />
        ) : (
          <View style={styles.heroFallback}>
            <FontAwesome5 name="user-alt" size={96} color="rgba(255,255,255,0.85)" />
          </View>
        )}
        <HeroGradient />
        <Animated.View
          pointerEvents="none"
          style={[
            { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
            { opacity: shadeOpacity },
          ]}
        />
      </View>

      <Animated.ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
      >
        {/* Scrollable hero foreground (name + camera) */}
        <View style={styles.heroForeground}>
          <TouchableOpacity
            onPress={showImagePickerOptions}
            disabled={loader}
            activeOpacity={0.85}
            style={[styles.cameraFab, { backgroundColor: themeColor }]}
          >
            {loader ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="camera" size={20} color="#fff" />
            )}
          </TouchableOpacity>

          <View style={styles.heroOverlay} pointerEvents="none">
            <Text style={styles.heroName} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.heroStatus} numberOfLines={1}>online</Text>
          </View>
        </View>

        {/* ─── ACCOUNT section ─── */}
        <Text style={[styles.sectionLabel, { color: subText }]}>ACCOUNT</Text>
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          {/* Phone — tappable ONLY when empty (locked once set) */}
          <InfoTappableRow
            icon="call-outline"
            iconColor={themeColor}
            label="mobile number"
            value={displayPhone || 'Add mobile number'}
            valueColor={displayPhone ? primaryText : themeColor}
            sub={subText}
            onPress={
              phoneNumber
                ? null
                : () => navigation.navigate('PersonalInfoEdit', {
                    field: 'mobile',
                    value: phoneNumber,
                    extra: { code: phoneCode },
                  })
            }
          />

          <View style={[styles.divider, { backgroundColor: borderClr }]} />

          {/* Email — tappable ONLY when empty (locked once set) */}
          <InfoTappableRow
            icon="mail-outline"
            iconColor={themeColor}
            label="email"
            value={userEmail || 'Add email'}
            valueColor={userEmail ? primaryText : themeColor}
            sub={subText}
            onPress={
              userEmail
                ? null
                : () => navigation.navigate('PersonalInfoEdit', {
                    field: 'email',
                    value: userEmail,
                  })
            }
          />

          {userName ? (
            <>
              <View style={[styles.divider, { backgroundColor: borderClr }]} />
              <InfoTappableRow
                icon="at-outline"
                iconColor={themeColor}
                label="username"
                value={`@${userName}`}
                valueColor={primaryText}
                sub={subText}
              />
            </>
          ) : null}
        </View>

        {/* ─── INFO section ─── */}
        <Text style={[styles.sectionLabel, { color: subText }]}>INFO</Text>
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          {/* Name */}
          <InfoTappableRow
            icon="person-outline"
            iconColor={themeColor}
            label="name"
            value={profileData?.fullName || 'Add name'}
            valueColor={profileData?.fullName ? primaryText : themeColor}
            sub={subText}
            onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'fullName', value: profileData?.fullName })}
          />

          <View style={[styles.divider, { backgroundColor: borderClr }]} />

          {/* About */}
          <InfoTappableRow
            icon="information-circle-outline"
            iconColor={themeColor}
            label="about"
            value={aboutText || 'Add bio'}
            valueColor={aboutText ? primaryText : themeColor}
            sub={subText}
            multiline
            onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'about', value: aboutText })}
          />
        </View>

        {/* ─── ACTIONS card ─── */}
        <Text style={[styles.sectionLabel, { color: subText }]}>SETTINGS</Text>
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          <ActionRow
            icon="settings-outline"
            iconColor={themeColor}
            label="Settings"
            primary={primaryText}
            onPress={() => navigation.navigate('SettingsTab')}
          />
          <View style={[styles.divider, { backgroundColor: borderClr }]} />
          <ActionRow
            icon="qr-code-outline"
            iconColor={themeColor}
            label="Linked Devices"
            primary={primaryText}
            onPress={() => navigation.navigate('LinkDevice')}
          />
        </View>
      </Animated.ScrollView>
    </Animated.View>
  );
}

// ─── Reusable rows ───
function InfoTappableRow({ icon, iconColor, label, value, valueColor, sub, onPress, multiline }) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.rowIcon, { backgroundColor: iconColor + '18' }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowValue, { color: valueColor }]} numberOfLines={multiline ? 0 : 1}>
          {value}
        </Text>
        <Text style={[styles.rowLabel, { color: sub }]}>{label}</Text>
      </View>
      {onPress && <Ionicons name="chevron-forward" size={16} color={sub} />}
    </Wrapper>
  );
}

function ActionRow({ icon, iconColor, label, primary, onPress }) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.rowIcon, { backgroundColor: iconColor + '18' }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <Text style={[styles.actionLabel, { color: primary }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={primary + '70'} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Top bar
  topBarSafe: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
  },
  topBarRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6,
  },
  floatingBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Hero
  hero: {
    position: 'absolute', top: 0, left: 0, right: 0,
    width: '100%', height: HERO_H, overflow: 'hidden',
  },
  heroForeground: { width: '100%', height: HERO_H, position: 'relative' },
  heroImage: { width: '100%', height: '100%' },
  heroFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroOverlay: { position: 'absolute', left: 20, right: 80, bottom: 18 },
  heroName: {
    color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 26,
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

  // Section label
  sectionLabel: {
    fontFamily: 'Roboto-Medium', fontSize: 11, letterSpacing: 0.8,
    marginTop: 18, marginBottom: 6, paddingHorizontal: 24,
  },

  // Cards
  card: {
    marginHorizontal: 12, borderRadius: 14, overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 14, gap: 14,
  },
  rowIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  rowValue: { fontFamily: 'Roboto-Medium', fontSize: 15 },
  rowLabel: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: 2 },
  actionLabel: { flex: 1, fontFamily: 'Roboto-Medium', fontSize: 15 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 64 },
});
