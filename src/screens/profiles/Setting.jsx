import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  View, Text, Image, Animated, TouchableOpacity, ScrollView,
  Alert, StyleSheet, ActivityIndicator, Platform,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { useFocusEffect } from "@react-navigation/native";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { resetToLogin } from "../../Redux/Services/navigationService";
import { useAuth } from "../../contexts/AuthContext";
import { Ionicons, FontAwesome6, AntDesign } from '@expo/vector-icons';
import { APP_TAG_NAME } from '@env';
import ChatBackupService from '../../services/ChatBackupService';
import VerifiedBadge from '../../components/VerifiedBadge';
import { openCallReliability } from '../../calls/services/callReliability';

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393'];

export default function Setting({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const { logout } = useAuth();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(14)).current;
  const dispatch = useDispatch();
  const { profileData } = useSelector(state => state.profile);

  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 380, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      dispatch(profileDetail()).catch(() => {});
    }, [dispatch])
  );

  function getInitials(name) {
    if (!name) return "";
    return name.trim().split(" ").map((p) => p.charAt(0).toUpperCase()).join("").slice(0, 2);
  }

  const handleLogout = async () => {
    // Funnel through the single AuthContext.logout(): server notify (deactivate push
    // token) + clear storage + disconnect + setIsAuthenticated(false). That last step
    // unmounts every call/message listener — calling the socket helpers directly left
    // isAuthenticated=true, so the user kept receiving calls after logout.
    try {
      await logout();
    } catch (_e) { /* ignore — still redirect to login */ }

    // Redirect to the Login screen on the ROOT navigator. This screen lives
    // inside the bottom-tab navigator, so its own `navigation.reset` can't
    // reach the root 'Login' route. `resetToLogin` resets via the NavigationContainer ref.
    resetToLogin();
  };

  const confirmLogout = () => {
    Alert.alert("Log out", "Are you sure you want to log out from this device?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: handleLogout },
    ]);
  };

  const handleBackup = async () => {
    if (isBackingUp) return;
    setIsBackingUp(true);
    setBackupStatus('Preparing…');
    try {
      await ChatBackupService.createAndShareBackup((status) => setBackupStatus(status));
      setBackupStatus('');
    } catch (err) {
      if (!err?.message?.includes('User did not share')) {
        Alert.alert('Backup Failed', err?.message || 'Could not create backup. Please try again.');
      }
      setBackupStatus('');
    } finally {
      setIsBackingUp(false);
    }
  };

  // ─── WhatsApp palette ───
  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const iconColor = theme.colors.iconColor;
  // Uniform colour: the page and every card share the theme `background` token,
  // so all sections show the same colour. Cards stay delineated by their edges.
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;

  const avatarBg = AVATAR_COLORS[
    ((profileData?.fullName || '').charCodeAt(0) || 0) % AVATAR_COLORS.length
  ] || AVATAR_COLORS[0];

  const menuSections = useMemo(() => ([
    {
      title: 'Preferences',
      items: [
        {
          icon: 'color-palette-outline',
          label: 'Appearance',
          subtitle: isDarkMode ? 'Dark theme' : 'Light theme',
          onPress: () => navigation.navigate('ChatColorTheme'),
        },
        {
          icon: 'lock-closed-outline',
          label: 'Chat privacy',
          subtitle: 'Chat delete & app lock password',
          onPress: () => navigation.navigate('ChatPrivacy'),
        },
      ],
    },
    // OEM skins (MIUI, FuntouchOS, …) block a killed/rebooted app from waking on
    // the incoming-call push. This re-opens the battery-optimization + Autostart
    // onboarding so calls ring when the app is closed. Android-only.
    ...(Platform.OS === 'android' ? [{
      title: 'Calls',
      items: [
        {
          icon: 'call-outline',
          label: 'Call reliability',
          subtitle: 'Let calls ring when the app is closed',
          onPress: () => openCallReliability(),
        },
      ],
    }] : []),
    // {
    //   title: 'Chats',
    //   items: [
    //     {
    //       icon: 'cloud-upload-outline',
    //       label: 'Chat backup',
    //       subtitle: backupStatus || 'Export and share your messages',
    //       isLoading: isBackingUp,
    //       onPress: handleBackup,
    //     },
    //   ],
    // },
    {
      title: 'Account',
      items: [
        {
          icon: 'person-circle-outline',
          label: 'Privacy & Account',
          subtitle: 'Privacy, devices, delete account',
          onPress: () => navigation.navigate('PrivacyAccount'),
        },
        {
          icon: 'help-buoy-outline',
          label: 'Help & Support',
          subtitle: 'FAQs, contact support, tickets',
          onPress: () => navigation.navigate('HelpSupport'),
        },
        {
          icon: 'flag-outline',
          label: 'My Reports',
          subtitle: 'Reports you have submitted',
          onPress: () => navigation.navigate('MyReports'),
        },
      ],
    },
    {
      title: 'About',
      items: [
        {
          icon: 'shield-checkmark-outline',
          label: 'Privacy policy',
          subtitle: 'How we protect your data',
          onPress: () => navigation.navigate('Privacy'),
        },
        {
          icon: 'document-text-outline',
          label: 'Terms & conditions',
          subtitle: 'Our terms of service',
          onPress: () => navigation.navigate('Term'),
        },
      ],
    },
  ]), [isDarkMode, isBackingUp, backupStatus]);


  const renderProfileCard = () => (
    <TouchableOpacity
      onPress={() => navigation.navigate('ProfileTab')}
      activeOpacity={0.65}
      style={[styles.profileCard, { backgroundColor: cardBg }]}
    >
      <View style={[styles.profileAvatar, { backgroundColor: avatarBg }]}>
        {profileData?.profileImage ? (
          <Image resizeMode="cover" source={{ uri: profileData.profileImage }} style={styles.profileAvatarImage} />
        ) : (
          <Text style={styles.profileAvatarText}>{getInitials(profileData?.fullName)}</Text>
        )}
      </View>

      <View style={styles.profileInfo}>
        <View style={styles.profileNameRow}>
          <Text style={[styles.profileName, { color: primaryText, flexShrink: 1 }]} numberOfLines={1}>
            {profileData?.fullName || 'User'}
          </Text>
          <VerifiedBadge verified={profileData?.isVerified} size={16} />
        </View>
        <Text style={[styles.profileSub, { color: subText }]} numberOfLines={1}>
          {profileData?.about || profileData?.email || 'Tap to set up your profile'}
        </Text>
      </View>

      <View style={[styles.qrBtn, { backgroundColor: accent + '14' }]}>
        <AntDesign name="edit" size={20} color={accent} />
      </View>
    </TouchableOpacity>
  );

  const renderMenuItem = (item) => (
    <TouchableOpacity
      key={item.label}
      onPress={item.onPress}
      disabled={item.isLoading}
      activeOpacity={0.6}
      style={styles.menuItem}
    >
      <View style={styles.menuIconWrap}>
        {item.isLoading ? (
          <ActivityIndicator size="small" color={accent} />
        ) : (
          <Ionicons name={item.icon} size={23} color={iconColor} />
        )}
      </View>
      <View style={styles.menuTextWrap}>
        <Text style={[styles.menuLabel, { color: primaryText }]}>{item.label}</Text>
        {item.subtitle ? (
          <Text
            numberOfLines={1}
            style={[styles.menuSubtitle, { color: item.isLoading ? accent : subText }]}
          >
            {item.subtitle}
          </Text>
        ) : null}
      </View>
      {!item.isLoading && (
        <Ionicons name="chevron-forward" size={18} color={subText} />
      )}
    </TouchableOpacity>
  );

  const renderLogout = () => (
    <View style={styles.logoutWrap}>
      <TouchableOpacity
        onPress={confirmLogout}
        activeOpacity={0.6}
        style={[styles.logoutBtn, { backgroundColor: cardBg }]}
      >
        <Ionicons name="log-out-outline" size={22} color="#E53935" />
        <Text style={styles.logoutText}>Log out</Text>
      </TouchableOpacity>
      {/* <Text style={[styles.versionText, { color: subText }]}>
        {APP_TAG_NAME || 'App'} · v1.0.0
      </Text> */}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          activeOpacity={0.6}
          style={styles.headerBackBtn}
        >
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Animated.View style={{ flex: 1, opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
        <ScrollView
          style={styles.flex}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {renderProfileCard()}

          {/* All menu rows in one continuous list with equal spacing (WhatsApp
              style) — no per-section grouping gaps, no row dividers. */}
          <View style={styles.menuList}>
            {menuSections.flatMap((s) => s.items).map((item) => renderMenuItem(item))}
          </View>

          {renderLogout()}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 6,
  },
  headerBackBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: 'Roboto-Bold',
    fontSize: 22,
    letterSpacing: -0.3,
  },
  headerSpacer: { width: 40 },

  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    paddingTop: 4,
  },


  // Profile card
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 16,
    gap: 14,
    marginBottom: 24,
  },
  profileAvatar: {
    width: 58, height: 58, borderRadius: 29,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  profileAvatarImage: { width: 58, height: 58, borderRadius: 29 },
  profileAvatarText: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 22,
  },
  profileInfo: { flex: 1, gap: 3 },
  profileNameRow: { flexDirection: 'row', alignItems: 'center' },
  profileName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    textTransform: 'capitalize',
    lineHeight: 23,
  },
  profileSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 17,
  },
  qrBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },

  // Menu list (continuous, equal-gap rows — no dividers)
  menuList: {
    marginBottom: 10,
  },

  // Menu items
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 16,
    minHeight: 58,
  },
  menuIconWrap: {
    width: 24, height: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  menuTextWrap: { flex: 1 },
  menuLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 16,
    lineHeight: 21,
  },
  menuSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 2,
    lineHeight: 17,
  },
  // Logout
  logoutWrap: {
    marginTop: 4,
    alignItems: 'center',
    gap: 18,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    width: '100%',
    paddingVertical: 15,
    borderRadius: 14,
  },
  logoutText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    color: '#E53935',
  },
  versionText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    letterSpacing: 0.3,
  },
});
