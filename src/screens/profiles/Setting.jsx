import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, Image, Animated, TouchableOpacity, ScrollView,
  Alert, StyleSheet, ActivityIndicator, Dimensions,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { useFocusEffect } from "@react-navigation/native";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { emitLogoutCurrentDevice, clearLocalStorageAndDisconnect } from "../../Redux/Services/Socket/socket";
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import { APP_TAG_NAME } from '@env';
import ChatBackupService from '../../services/ChatBackupService';

const { width: SCREEN_W } = Dimensions.get('window');
const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393'];

export default function Setting({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;
  const dispatch = useDispatch();
  const { profileData } = useSelector(state => state.profile);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
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
    try {
      await emitLogoutCurrentDevice();
      await clearLocalStorageAndDisconnect();
      navigation.reset({ index: 0, routes: [{ name: "LoginEmail" }] });
    } catch (error) {
      Alert.alert("Error", "An error occurred while logging out. Please try again.");
    }
  };

  const confirmLogout = () => {
    Alert.alert("Logout", "Are you sure you want to logout from this device?", [
      { text: "Cancel", style: "cancel" },
      { text: "Logout", style: "destructive", onPress: handleLogout },
    ]);
  };

  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');

  const handleBackup = async () => {
    if (isBackingUp) return;
    setIsBackingUp(true);
    setBackupStatus('Preparing...');
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

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = isDarkMode ? '#0B141A' : '#F4F6F9';
  const cardBg = isDarkMode ? '#16222C' : '#FFFFFF';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(15,30,50,0.06)';

  const avatarBg = AVATAR_COLORS[
    ((profileData?.fullName || '').charCodeAt(0) || 0) % AVATAR_COLORS.length
  ] || AVATAR_COLORS[0];

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
        {
          icon: 'lock-closed-outline',
          iconColor: '#0984E3',
          iconBg: '#0984E31A',
          label: 'Chat Privacy',
          subtitle: 'Deleted chats password',
          onPress: () => navigation.navigate('ChatPrivacy'),
        },
      ],
    },
    {
      title: 'Support',
      items: [
        {
          icon: 'shield-checkmark-outline',
          iconColor: '#00B894',
          iconBg: '#00B8941A',
          label: 'Privacy Policy',
          subtitle: 'How we protect your data',
          onPress: () => navigation.navigate('Privacy'),
        },
        {
          icon: 'document-text-outline',
          iconColor: '#E17055',
          iconBg: '#E170551A',
          label: 'Terms & Conditions',
          subtitle: 'Our terms of service',
          onPress: () => navigation.navigate('Term'),
        },
      ],
    },
  ];

  const renderProfileCard = () => (
    <Animated.View style={[
      styles.profileCardWrap,
      { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
    ]}>
      {/* Halo behind avatar */}
      <View pointerEvents="none" style={[styles.profileHalo, { backgroundColor: themeColor + '15' }]} />
      <View pointerEvents="none" style={[styles.profileHalo2, { backgroundColor: themeColor + '08' }]} />

      <TouchableOpacity
        onPress={() => navigation.navigate('ProfileTab')}
        activeOpacity={0.85}
        style={[styles.profileCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}
      >
        <View style={[styles.avatarRing, { borderColor: themeColor + '30' }]}>
          <View style={[styles.profileAvatar, { backgroundColor: avatarBg }]}>
            {profileData?.profileImage ? (
              <Image resizeMode="cover" source={{ uri: profileData.profileImage }} style={styles.profileAvatarImage} />
            ) : (
              <Text style={styles.profileAvatarText}>{getInitials(profileData?.fullName)}</Text>
            )}
          </View>
        </View>

        <View style={styles.profileInfo}>
          <Text style={[styles.profileName, { color: primaryText }]} numberOfLines={1}>
            {profileData?.fullName || 'User'}
          </Text>
          <Text style={[styles.profileSub, { color: subText }]} numberOfLines={1}>
            {profileData?.about || profileData?.email || 'Tap to set up your profile'}
          </Text>
          <View style={[styles.viewProfilePill, { backgroundColor: themeColor + '15' }]}>
            <Text style={[styles.viewProfileText, { color: themeColor }]}>View profile</Text>
            <Ionicons name="chevron-forward" size={11} color={themeColor} />
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
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
      <View style={[
        styles.menuTextWrap,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: borderClr },
      ]}>
        <View style={styles.menuLabelWrap}>
          <Text style={[styles.menuLabel, { color: primaryText }]}>{item.label}</Text>
          {item.subtitle ? (
            <Text style={[
              styles.menuSubtitle,
              { color: item.isLoading ? themeColor : subText },
            ]}>{item.subtitle}</Text>
          ) : null}
        </View>
        {!item.isLoading && (
          <Ionicons name="chevron-forward" size={17} color={subText} />
        )}
      </View>
    </TouchableOpacity>
  );

  const renderSection = (section, sectionIndex) => (
    <View key={sectionIndex} style={styles.sectionWrap}>
      <Text style={[styles.sectionTitle, { color: subText }]}>{section.title}</Text>
      <View style={[
        styles.sectionCard,
        { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' },
      ]}>
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
        style={[styles.logoutBtn, { borderColor: '#E5393530' }]}
      >
        <Ionicons name="log-out-outline" size={20} color="#E53935" />
        <Text style={styles.logoutText}>Log out</Text>
      </TouchableOpacity>
      <Text style={[styles.versionText, { color: subText }]}>
        {APP_TAG_NAME || 'App'} · v1.0.0
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          activeOpacity={0.6}
          style={[styles.headerBackBtn, { backgroundColor: cardBg }]}
        >
          <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {renderProfileCard()}
        {menuSections.map((section, i) => renderSection(section, i))}
        {renderLogout()}
      </ScrollView>
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
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  headerBackBtn: {
    width: 40, height: 40, borderRadius: 12,
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
    paddingBottom: 36,
    paddingTop: 6,
  },

  // Profile card
  profileCardWrap: {
    position: 'relative',
    marginBottom: 26,
  },
  profileHalo: {
    position: 'absolute',
    top: -36, left: -20,
    width: 160, height: 160, borderRadius: 80,
  },
  profileHalo2: {
    position: 'absolute',
    top: -10, right: -30,
    width: 130, height: 130, borderRadius: 65,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 20,
    gap: 14,
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 18,
    elevation: 3,
  },
  avatarRing: {
    width: 70, height: 70, borderRadius: 35,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatar: {
    width: 60, height: 60, borderRadius: 30,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  profileAvatarImage: { width: 60, height: 60, borderRadius: 30 },
  profileAvatarText: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 22,
  },
  profileInfo: { flex: 1, gap: 3 },
  profileName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    textTransform: 'capitalize',
    lineHeight: 22,
  },
  profileSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    lineHeight: 16,
  },
  viewProfilePill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 10,
    marginTop: 5,
  },
  viewProfileText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 0.3,
  },

  // Sections
  sectionWrap: { marginBottom: 18 },
  sectionTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 10,
    marginLeft: 8,
  },
  sectionCard: {
    borderRadius: 18,
    overflow: 'hidden',
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 2,
  },

  // Menu items
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    gap: 14,
  },
  menuIconWrap: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  menuTextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingRight: 16,
  },
  menuLabelWrap: { flex: 1 },
  menuLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    lineHeight: 20,
  },
  menuSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },

  // Logout
  logoutWrap: {
    marginTop: 16,
    alignItems: 'center',
    gap: 16,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    paddingVertical: 15,
    borderRadius: 16,
    borderWidth: 1.5,
    backgroundColor: 'transparent',
  },
  logoutText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    color: '#E53935',
  },
  versionText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    letterSpacing: 0.3,
  },
});
