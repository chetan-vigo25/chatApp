import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  Image,
  Animated,
  TouchableOpacity,
  ScrollView,
  Alert,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { emitLogoutCurrentDevice, clearLocalStorageAndDisconnect } from "../../Redux/Services/Socket/socket";
import { Ionicons, FontAwesome6, MaterialCommunityIcons } from '@expo/vector-icons';
import { APP_TAG_NAME } from '@env';
import ChatBackupService from '../../services/ChatBackupService';

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393'];

export default function Setting({ navigation }) {
  const { theme, toggleTheme, isDarkMode, hasManualTheme, setTheme, resetThemeToSystem } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { profileData, isLoading, error } = useSelector(state => state.profile);

  useEffect(() => {
    dispatch(profileDetail());
    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  function getInitials(name) {
    if (!name) return "";
    const parts = name.trim().split(" ");
    return parts.map((p) => p.charAt(0).toUpperCase()).join("");
  }

  const handleLogout = async () => {
    try {
      const payload = await emitLogoutCurrentDevice();
      console.log("Emitting logout for current device", payload);

      await clearLocalStorageAndDisconnect();

      navigation.reset({
        index: 0,
        routes: [{ name: "Login" }],
      });

      console.log("Logged out from current device.");
    } catch (error) {
      console.error("Error logging out:", error);
      Alert.alert("Error", "An error occurred while logging out. Please try again.");
    }
  };

  const confirmLogout = () => {
    Alert.alert(
      "Logout",
      "Are you sure you want to logout from this device?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Logout", style: "destructive", onPress: handleLogout },
      ]
    );
  };

  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');

  const handleBackup = async () => {
    if (isBackingUp) return;
    setIsBackingUp(true);
    setBackupStatus('Preparing...');
    try {
      const result = await ChatBackupService.createAndShareBackup((status) => {
        setBackupStatus(status);
      });
      setBackupStatus('');
    } catch (err) {
      if (err?.message?.includes('User did not share')) {
        // User cancelled the share sheet — not an error
        setBackupStatus('');
      } else {
        console.error('Backup error:', err);
        Alert.alert('Backup Failed', err?.message || 'Could not create backup. Please try again.');
        setBackupStatus('');
      }
    } finally {
      setIsBackingUp(false);
    }
  };

  const avatarBg = AVATAR_COLORS[
    (profileData?.fullName || '').charCodeAt(0) % AVATAR_COLORS.length
  ] || AVATAR_COLORS[0];

  // ─── MENU ITEMS CONFIG ───
  const menuSections = [
    {
      title: 'General',
      items: [
        {
          icon: 'color-palette-outline',
          iconColor: '#6C5CE7',
          iconBg: '#6C5CE71A',
          label: 'Appearance',
          subtitle: isDarkMode ? 'Dark theme' : 'Light theme',
          onPress: () => navigation.navigate('ChatColorTheme'),
        },
      ],
    },
    // {
    //   title: 'Data & Storage',
    //   items: [
    //     {
    //       icon: 'cloud-download-outline',
    //       iconColor: '#0984E3',
    //       iconBg: '#0984E31A',
    //       label: 'Chat Backup',
    //       subtitle: isBackingUp ? backupStatus : 'Auto-save to VibeConnect/Databases/',
    //       onPress: handleBackup,
    //       isLoading: isBackingUp,
    //     },
    //   ],
    // },
    {
      title: 'Support',
      items: [
        {
          icon: 'shield-checkmark-outline',
          iconColor: '#00B894',
          iconBg: '#00B8941A',
          label: 'Privacy Policy',
          onPress: () => navigation.navigate('Privacy'),
        },
        {
          icon: 'document-text-outline',
          iconColor: '#E17055',
          iconBg: '#E170551A',
          label: 'Terms & Conditions',
          onPress: () => navigation.navigate('Term'),
        },
      ],
    },
  ];

  // ─── RENDER ───

  const renderProfileCard = () => (
    <TouchableOpacity
      onPress={() => navigation.navigate('ProfileTab')}
      activeOpacity={0.7}
      style={[styles.profileCard, { backgroundColor: theme.colors.menuBackground }]}
    >
      {/* Avatar */}
      <View style={[styles.profileAvatar, { backgroundColor: avatarBg }]}>
        {profileData?.profileImage ? (
          <Image
            resizeMode="cover"
            source={{ uri: profileData?.profileImage }}
            style={styles.profileAvatarImage}
          />
        ) : (
          <Text style={styles.profileAvatarText}>
            {getInitials(profileData?.fullName)}
          </Text>
        )}
      </View>

      {/* Info */}
      <View style={styles.profileInfo}>
        <Text style={[styles.profileName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
          {profileData?.fullName || 'User'}
        </Text>
        <Text style={[styles.profileSub, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
          {profileData?.about || profileData?.email || 'Set your status'}
        </Text>
      </View>

      {/* Edit icon */}
      <View style={[styles.profileEditBtn, { backgroundColor: theme.colors.themeColor + '15' }]}>
        <Ionicons name="create-outline" size={18} color={theme.colors.themeColor} />
      </View>
    </TouchableOpacity>
  );

  const renderMenuItem = (item, index, isLast) => (
    <TouchableOpacity
      key={index}
      onPress={item.onPress}
      disabled={item.isLoading}
      activeOpacity={0.6}
      style={styles.menuItem}
    >
      <View style={[styles.menuIconWrap, { backgroundColor: item.iconBg }]}>
        {item.isLoading ? (
          <ActivityIndicator size="small" color={item.iconColor} />
        ) : (
          <Ionicons name={item.icon} size={20} color={item.iconColor} />
        )}
      </View>
      <View style={[styles.menuTextWrap, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.borderColor + '40' }]}>
        <View style={styles.menuLabelWrap}>
          <Text style={[styles.menuLabel, { color: theme.colors.primaryTextColor }]}>{item.label}</Text>
          {item.subtitle && (
            <Text style={[styles.menuSubtitle, { color: item.isLoading ? theme.colors.themeColor : theme.colors.placeHolderTextColor }]}>{item.subtitle}</Text>
          )}
        </View>
        {!item.isLoading && (
          <Ionicons name="chevron-forward" size={17} color={theme.colors.placeHolderTextColor} />
        )}
      </View>
    </TouchableOpacity>
  );

  const renderSection = (section, sectionIndex) => (
    <View key={sectionIndex} style={styles.sectionWrap}>
      <Text style={[styles.sectionTitle, { color: theme.colors.placeHolderTextColor }]}>
        {section.title}
      </Text>
      <View style={[styles.sectionCard, { backgroundColor: theme.colors.menuBackground }]}>
        {section.items.map((item, i) =>
          renderMenuItem(item, i, i === section.items.length - 1)
        )}
      </View>
    </View>
  );

  const renderLogout = () => (
    <View style={styles.logoutWrap}>
      <TouchableOpacity
        onPress={confirmLogout}
        activeOpacity={0.7}
        style={[styles.logoutBtn, { backgroundColor: '#E5393520' }]}
      >
        <Ionicons name="log-out-outline" size={20} color="#E53935" />
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>

      {/* <Text style={[styles.versionText, { color: theme.colors.placeHolderTextColor }]}>
        {APP_TAG_NAME || 'App'} v1.0.0
      </Text> */}
    </View>
  );

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Settings</Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {renderProfileCard()}
        {menuSections.map((section, i) => renderSection(section, i))}
        {renderLogout()}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // ─── HEADER ───
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 12,
    gap: 6,
  },
  headerBackBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
  },
  headerTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    letterSpacing: 0.2,
  },

  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },

  // ─── PROFILE CARD ───
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 24,
    gap: 14,
  },
  profileAvatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  profileAvatarImage: {
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  profileAvatarText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 22,
    textTransform: 'uppercase',
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    textTransform: 'capitalize',
    lineHeight: 23,
  },
  profileSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 1,
    lineHeight: 18,
  },
  profileEditBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ─── SECTIONS ───
  sectionWrap: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionCard: {
    borderRadius: 14,
    overflow: 'hidden',
  },

  // ─── MENU ITEMS ───
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    gap: 12,
  },
  menuIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuTextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingRight: 14,
  },
  menuLabelWrap: {
    flex: 1,
  },
  menuLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    lineHeight: 21,
  },
  menuSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: -1,
  },

  // ─── LOGOUT ───
  logoutWrap: {
    marginTop: 'auto',
    paddingTop: 20,
    alignItems: 'center',
    gap: 12,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    paddingVertical: 14,
    borderRadius: 14,
  },
  logoutText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    color: '#E53935',
  },
  versionText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    marginTop: 4,
  },
});