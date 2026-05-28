import React, { useState, useRef, useCallback } from "react";
import {
  View, Text, Image, Animated, TouchableOpacity,
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
import { FontAwesome6, Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = Math.min(SCREEN_W, 440);

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

export default function Profile({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const [selectedImage, setSelectedImage] = useState(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { profileData } = useSelector(state => state.profile);
  const [loader, setLoader] = useState(false);
  const scrollY = useRef(new Animated.Value(0)).current;

  const heroScale = scrollY.interpolate({
    inputRange: [-100, 0],
    outputRange: [1.15, 1],
    extrapolateRight: 'clamp',
  });
  const heroTranslate = scrollY.interpolate({
    inputRange: [0, HERO_H],
    outputRange: [0, -HERO_H * 0.35],
    extrapolate: 'clamp',
  });

  useFocusEffect(
    useCallback(() => {
      dispatch(profileDetail());
      Animated.timing(fadeAnim, { toValue: 1, duration: 320, useNativeDriver: true }).start();
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

  const pageBg = isDarkMode ? '#0B141A' : '#F4F6F9';
  const cardBg = isDarkMode ? '#16222C' : '#FFFFFF';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(15,30,50,0.06)';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor || '#1DA1F2';

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: pageBg }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={isDarkMode ? 'light-content' : 'dark-content'} />

      {/* Top bar */}
      <SafeAreaView edges={['top']} style={styles.topBarSafe}>
        <View style={styles.topBarRow}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.floatingBtn} activeOpacity={0.7}>
            <FontAwesome6 name="arrow-left" size={18} color="#fff" />
          </TouchableOpacity>
          <View style={styles.flex} />
          <TouchableOpacity
            onPress={() => navigation.navigate('SettingsTab')}
            style={styles.floatingBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="settings-outline" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Hero (parallax) */}
      <Animated.View
        style={[
          styles.hero,
          {
            backgroundColor: imageUri ? '#000' : themeColor,
            transform: [{ translateY: heroTranslate }, { scale: heroScale }],
          },
        ]}
        pointerEvents="none"
      >
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.heroImage} resizeMode="cover" />
        ) : (
          <View style={styles.heroFallback}>
            <FontAwesome5 name="user-alt" size={108} color="rgba(255,255,255,0.85)" />
          </View>
        )}
      </Animated.View>

      <Animated.ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
      >
        {/* Hero foreground */}
        <View style={styles.heroForeground}>
          <View style={styles.heroOverlay} pointerEvents="none">
            <Text style={styles.heroName} numberOfLines={1}>{displayName}</Text>
            <View style={styles.heroStatusRow}>
              <View style={styles.onlineDot} />
              <Text style={styles.heroStatus} numberOfLines={1}>online</Text>
              {userName ? (
                <>
                  <View style={styles.heroDivider} />
                  <Text style={styles.heroStatus} numberOfLines={1}>@{userName}</Text>
                </>
              ) : null}
            </View>
          </View>

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
        </View>

        {/* ACCOUNT */}
        <Text style={[styles.sectionLabel, { color: subText }]}>ACCOUNT</Text>
        <View style={[
          styles.card,
          { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' },
        ]}>
          <InfoTappableRow
            icon="call-outline"
            iconColor={themeColor}
            label="Mobile number"
            value={displayPhone || 'Add mobile number'}
            valueColor={displayPhone ? primaryText : themeColor}
            sub={subText}
            onPress={
              phoneNumber
                ? null
                : () => navigation.navigate('PersonalInfoEdit', {
                    field: 'mobile', value: phoneNumber, extra: { code: phoneCode },
                  })
            }
          />
          <View style={[styles.divider, { backgroundColor: borderClr }]} />
          <InfoTappableRow
            icon="mail-outline"
            iconColor={themeColor}
            label="Email"
            value={userEmail || 'Add email'}
            valueColor={userEmail ? primaryText : themeColor}
            sub={subText}
            onPress={
              userEmail
                ? null
                : () => navigation.navigate('PersonalInfoEdit', { field: 'email', value: userEmail })
            }
          />
          {userName ? (
            <>
              <View style={[styles.divider, { backgroundColor: borderClr }]} />
              <InfoTappableRow
                icon="at-outline"
                iconColor={themeColor}
                label="Username"
                value={`@${userName}`}
                valueColor={primaryText}
                sub={subText}
              />
            </>
          ) : null}
        </View>

        {/* INFO */}
        <Text style={[styles.sectionLabel, { color: subText }]}>PROFILE INFO</Text>
        <View style={[
          styles.card,
          { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' },
        ]}>
          <InfoTappableRow
            icon="person-outline"
            iconColor={themeColor}
            label="Name"
            value={profileData?.fullName || 'Add name'}
            valueColor={profileData?.fullName ? primaryText : themeColor}
            sub={subText}
            onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'fullName', value: profileData?.fullName })}
          />
          <View style={[styles.divider, { backgroundColor: borderClr }]} />
          <InfoTappableRow
            icon="information-circle-outline"
            iconColor={themeColor}
            label="About"
            value={aboutText || 'Add a bio'}
            valueColor={aboutText ? primaryText : themeColor}
            sub={subText}
            multiline
            onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'about', value: aboutText })}
          />
        </View>

        {/* SETTINGS */}
        <Text style={[styles.sectionLabel, { color: subText }]}>PREFERENCES</Text>
        <View style={[
          styles.card,
          { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' },
        ]}>
          <ActionRow
            icon="settings-outline"
            iconColor={themeColor}
            label="Settings & Privacy"
            primary={primaryText}
            sub={subText}
            onPress={() => navigation.navigate('SettingsTab')}
          />
        </View>
      </Animated.ScrollView>
    </Animated.View>
  );
}

function InfoTappableRow({ icon, iconColor, label, value, valueColor, sub, onPress, multiline }) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.rowIcon, { backgroundColor: iconColor + '18' }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={styles.flex}>
        <Text style={[styles.rowLabel, { color: sub }]}>{label}</Text>
        <Text style={[styles.rowValue, { color: valueColor }]} numberOfLines={multiline ? 0 : 1}>
          {value}
        </Text>
      </View>
      {onPress && <Ionicons name="chevron-forward" size={16} color={sub} />}
    </Wrapper>
  );
}

function ActionRow({ icon, iconColor, label, primary, sub, onPress }) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.rowIcon, { backgroundColor: iconColor + '18' }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <Text style={[styles.actionLabel, { color: primary }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={sub} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },

  topBarSafe: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
  },
  topBarRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6,
  },
  floatingBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },

  hero: {
    position: 'absolute', top: 0, left: 0, right: 0,
    width: '100%', height: HERO_H, overflow: 'hidden',
  },
  heroImage: { width: '100%', height: '100%' },
  heroFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  heroForeground: { width: '100%', height: HERO_H, position: 'relative' },
  heroOverlay: { position: 'absolute', left: 22, right: 90, bottom: 20 },
  heroName: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 28,
    letterSpacing: -0.4,
  },
  heroStatusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 6,
  },
  onlineDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#25D366',
  },
  heroDivider: {
    width: 3, height: 3, borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.6)',
  },
  heroStatus: {
    color: 'rgba(255,255,255,0.92)',
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
  },
  cameraFab: {
    position: 'absolute', right: 20, bottom: 18,
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000', shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 }, shadowRadius: 6,
  },

  scrollContent: { paddingBottom: 48 },

  sectionLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11, letterSpacing: 1.2,
    marginTop: 22, marginBottom: 10, paddingHorizontal: 26,
  },

  card: {
    marginHorizontal: 14, borderRadius: 18, overflow: 'hidden',
    shadowOpacity: 0.05, shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12, elevation: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 14, gap: 14,
  },
  rowIcon: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  rowLabel: {
    fontFamily: 'Roboto-Medium', fontSize: 11,
    letterSpacing: 0.8, textTransform: 'uppercase',
    marginBottom: 3,
  },
  rowValue: { fontFamily: 'Roboto-SemiBold', fontSize: 15 },
  actionLabel: { flex: 1, fontFamily: 'Roboto-SemiBold', fontSize: 15 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 66 },
});
