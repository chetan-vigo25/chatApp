import React, { useState, useRef, useCallback } from "react";
import {
  View, Text, Image, Animated, TouchableOpacity,
  Alert, Platform, ToastAndroid, ActivityIndicator, StatusBar,
  StyleSheet, ScrollView,
} from "react-native";
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { BACKEND_URL } from '@env';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

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

  useFocusEffect(
    useCallback(() => {
      dispatch(profileDetail());
      Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: true }).start();
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
    Alert.alert('Profile photo', 'Choose an option', [
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

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor;
  const divider = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={isDarkMode ? 'light-content' : 'dark-content'} />

      {/* App bar */}
      <View edges={['top']} style={{ backgroundColor: theme.colors.background }}>
        <View style={styles.appBar}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.appBarBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="arrow-back" size={24} color={primaryText} />
          </TouchableOpacity>
          <Text style={[styles.appBarTitle, { color: primaryText }]}>Profile</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <TouchableOpacity activeOpacity={0.85} onPress={showImagePickerOptions} disabled={loader}>
            <View style={styles.avatarWrap}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: themeColor }]}>
                  <Ionicons name="person" size={72} color="#fff" />
                </View>
              )}
              <View style={[styles.cameraBadge, { backgroundColor: themeColor, borderColor: theme.colors.background }]}>
                {loader
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="camera" size={18} color="#fff" />}
              </View>
            </View>
          </TouchableOpacity>
        </View>

        {/* Editable fields — WhatsApp Settings > Profile */}
        <ProfileRow
          icon="person-outline"
          label="Name"
          value={profileData?.fullName || 'Add name'}
          valueColor={profileData?.fullName ? primaryText : themeColor}
          sub={subText}
          editable
          iconColor={themeColor}
          onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'fullName', value: profileData?.fullName })}
        />
        <View style={[styles.divider, { backgroundColor: divider }]} />

        <ProfileRow
          icon="information-circle-outline"
          label="About"
          value={aboutText || 'Add a bio'}
          valueColor={aboutText ? primaryText : themeColor}
          sub={subText}
          editable
          multiline
          iconColor={themeColor}
          onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'about', value: aboutText })}
        />
        <View style={[styles.divider, { backgroundColor: divider }]} />

        <ProfileRow
          icon="call-outline"
          label="Phone"
          value={displayPhone || 'Add mobile number'}
          valueColor={displayPhone ? primaryText : themeColor}
          sub={subText}
          iconColor={themeColor}
          onPress={
            phoneNumber
              ? undefined
              : () => navigation.navigate('PersonalInfoEdit', { field: 'mobile', value: phoneNumber, extra: { code: phoneCode } })
          }
        />

        {userEmail ? (
          <>
            <View style={[styles.divider, { backgroundColor: divider }]} />
            <ProfileRow icon="mail-outline" label="Email" value={userEmail} valueColor={primaryText} sub={subText} iconColor={themeColor} />
          </>
        ) : null}

        {userName ? (
          <>
            <View style={[styles.divider, { backgroundColor: divider }]} />
            <ProfileRow icon="at-outline" label="Username" value={`@${userName}`} valueColor={primaryText} sub={subText} iconColor={themeColor} />
          </>
        ) : null}
      </ScrollView>
    </Animated.View>
  );
}

function ProfileRow({ icon, label, value, valueColor, sub, iconColor, onPress, editable, multiline }) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <Ionicons name={icon} size={22} color={iconColor} style={styles.rowIcon} />
      <View style={styles.flex}>
        <Text style={[styles.rowValue, { color: valueColor }]} numberOfLines={multiline ? 0 : 1}>
          {value}
        </Text>
        <Text style={[styles.rowLabel, { color: sub }]}>{label}</Text>
      </View>
      {editable && onPress ? <Ionicons name="pencil" size={18} color={iconColor} /> : null}
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },

  appBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, height: 52, gap: 8,
  },
  appBarBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  appBarTitle: { fontFamily: 'Roboto-Medium', fontSize: 20 },

  avatarSection: { alignItems: 'center', paddingVertical: 24 },
  avatarWrap: { width: 140, height: 140 },
  avatar: { width: 140, height: 140, borderRadius: 70 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  cameraBadge: {
    position: 'absolute', right: 2, bottom: 2,
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3,
  },

  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 16, paddingHorizontal: 22, gap: 20,
  },
  rowIcon: { marginTop: 2 },
  rowValue: { fontFamily: 'Roboto-Regular', fontSize: 16 },
  rowLabel: { fontFamily: 'Roboto-Regular', fontSize: 13, marginTop: 3 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 64 },
});
