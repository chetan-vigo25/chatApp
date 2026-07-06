import React, { useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  Animated,
  StyleSheet,
  Platform,
  Image,
} from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { profileDetail } from '../Redux/Reducer/Profile/Profile.reducer';

// WhatsApp-style bottom tabs. The active tab shows a filled "pill" highlight
// behind the icon (Material-You / WhatsApp Android pattern) with the label
// beneath it. Order here is the visible left→right order of the bar.
const TABS = [
  { key: 'chats',    label: 'Chats',    lib: 'ion', icon: 'chatbubble',    iconOutline: 'chatbubble-outline' },
  { key: 'status',   label: 'Updates',  lib: 'mci', icon: 'record-circle', iconOutline: 'record-circle-outline' },
  { key: 'calls',    label: 'Calls',    lib: 'ion', icon: 'call',          iconOutline: 'call-outline' },
  { key: 'settings', label: 'You', lib: 'ion', icon: 'settings',      iconOutline: 'settings-outline' },
];

function TabIcon({ lib, name, size, color }) {
  if (lib === 'mci') return <MaterialCommunityIcons name={name} size={size} color={color} />;
  return <Ionicons name={name} size={size} color={color} />;
}

// First + last initial for the Settings-tab avatar fallback (no profile photo set).
function getInitials(name) {
  const n = (name || '').trim();
  if (!n) return '';
  const parts = n.split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '')).toUpperCase();
}

// The Settings tab shows the user's profile photo instead of a gear icon. Sized
// to match the 22px tab icons; a green ring marks the active state (mirroring how
// the other icons tint green when active).
function ProfileTabAvatar({ image, name, isActive, activeTint, inactiveTint }) {
  // Profile not loaded yet (fresh app open) → show the familiar gear icon rather
  // than a "?" placeholder. Once the photo/name arrives this swaps to the avatar.
  if (!image && !getInitials(name)) {
    return <Ionicons name={isActive ? 'settings' : 'settings-outline'} size={22} color={isActive ? activeTint : inactiveTint} />;
  }
  return (
    <View style={[styles.avatarWrap, { borderColor: isActive ? activeTint : 'transparent' }]}>
      {image ? (
        <Image source={{ uri: image }} style={styles.avatarImg} resizeMode="cover" />
      ) : (
        <View style={[styles.avatarFallback, { backgroundColor: activeTint }]}>
          <Text style={styles.avatarInitials}>{getInitials(name)}</Text>
        </View>
      )}
    </View>
  );
}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               

export default function BottomTabBar({ activeTab, onTabPress, theme, isDarkMode, unreadCount, missedCallCount = 0 }) {
  // The Settings tab renders the user's profile photo instead of the gear icon.
  const dispatch = useDispatch();
  const { profileData } = useSelector((state) => state.profile || {});
  const profileImage = profileData?.profileImageThumbnailUrl || profileData?.profileImage || null;
  const profileName = profileData?.fullName || '';

  // Profile is otherwise fetched only when the Settings screen mounts, so on a
  // fresh app open the tab bar had no photo/name and showed the "?" fallback.
  // Fetch it once here (when the always-mounted tab bar first appears) so the
  // avatar is ready immediately. Guarded so we don't refetch if it's already loaded.
  useEffect(() => {
    if (!profileData?.profileImage && !profileData?.fullName) {
      dispatch(profileDetail()).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scaleAnims = useRef(TABS.map(() => new Animated.Value(1))).current;
  const pillAnims = useRef(
    TABS.map((t) => new Animated.Value(t.key === activeTab ? 1 : 0))
  ).current;

  const activeIndex = TABS.findIndex((t) => t.key === activeTab);

  useEffect(() => {
    TABS.forEach((_, i) => {
      Animated.timing(pillAnims[i], {
        toValue: i === activeIndex ? 1 : 0,
        duration: 180,
        useNativeDriver: false,
      }).start();
    });
  }, [activeIndex]);

  const handlePress = (tab, index) => {
    Animated.sequence([
      Animated.timing(scaleAnims[index], { toValue: 0.9, duration: 50, useNativeDriver: true }),
      Animated.timing(scaleAnims[index], { toValue: 1, duration: 90, useNativeDriver: true }),
    ]).start();
    onTabPress(tab.key);
  };

  // WhatsApp's bottom bar is flat — the same colour as the screen background,
  // not an elevated lighter surface.
  const barBg = theme.colors.background;
  const activeTint = theme.colors.themeColor;
  const inactiveTint = theme.colors.placeHolderTextColor;
  const pillBg = (theme.colors.themeColor || '#00A884') + (isDarkMode ? '40' : '24');

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: barBg,
          borderTopColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        },
      ]}
    >
      {TABS.map((tab, index) => {
        const isActive = index === activeIndex;
        return (
          <TouchableOpacity
            key={tab.key}
            onPress={() => handlePress(tab, index)}
            activeOpacity={0.7}
            style={styles.tab}
          >
            <Animated.View style={[styles.tabInner, { transform: [{ scale: scaleAnims[index] }] }]}>
              {/* Pill highlight behind the icon */}
              <Animated.View
                style={[
                  styles.pill,
                  {
                    backgroundColor: pillAnims[index].interpolate({
                      inputRange: [0, 1],
                      outputRange: ['rgba(0,0,0,0)', pillBg],
                    }),
                  },
                ]}
              >
                <View style={styles.iconWrap}>
                  {tab.key === 'settings' ? (
                    <ProfileTabAvatar
                      image={profileImage}
                      name={profileName}
                      isActive={isActive}
                      activeTint={activeTint}
                      inactiveTint={inactiveTint}
                    />
                  ) : (
                    <TabIcon
                      lib={tab.lib}
                      name={isActive ? tab.icon : tab.iconOutline}
                      size={22}
                      color={isActive ? activeTint : inactiveTint}
                    />
                  )}
                  {tab.key === 'chats' && unreadCount > 0 && (
                    <View style={[styles.badge, { backgroundColor: activeTint }]}>
                      <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                    </View>
                  )}
                  {tab.key === 'calls' && missedCallCount > 0 && (
                    <View style={[styles.badge, { backgroundColor: '#F15C6D' }]}>
                      <Text style={styles.badgeText}>{missedCallCount > 99 ? '99+' : missedCallCount}</Text>
                    </View>
                  )}
                </View>
              </Animated.View>
              <Text
                style={[
                  styles.label,
                  {
                    // Label color is FIXED — black in light mode, white in dark mode —
                    // regardless of active/inactive state (only the icon tints green).
                    color: theme.colors.primaryTextColor,
                    fontFamily: isActive ? 'Roboto-Bold' : 'Roboto-Medium',
                  },
                ]}
              >
                {tab.label}
              </Text>
            </Animated.View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    height: Platform.OS === 'ios' ? 84 : 66,
    paddingBottom: Platform.OS === 'ios' ? 20 : 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    width: 60,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrap: {
    position: 'relative',
  },
  avatarWrap: {
    width: 30,
    height: 30,
    borderRadius: 100,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    borderRadius: 100,
  },
  avatarFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 10,
    fontFamily: 'Roboto-Bold',
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -12,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontFamily: 'Roboto-SemiBold',
  },
  label: {
    fontSize: 14,
    marginTop: 4,
    letterSpacing: 0.1,
  },
});
