import React, { useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  Animated,
  StyleSheet,
  Platform,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

// WhatsApp-style bottom tabs. The active tab shows a filled "pill" highlight
// behind the icon (Material-You / WhatsApp Android pattern) with the label
// beneath it. Order here is the visible left→right order of the bar.
const TABS = [
  { key: 'chats',    label: 'Chats',    lib: 'ion', icon: 'chatbubble',    iconOutline: 'chatbubble-outline' },
  { key: 'status',   label: 'Updates',  lib: 'mci', icon: 'record-circle', iconOutline: 'record-circle-outline' },
  { key: 'calls',    label: 'Calls',    lib: 'ion', icon: 'call',          iconOutline: 'call-outline' },
  { key: 'settings', label: 'Settings', lib: 'ion', icon: 'settings',      iconOutline: 'settings-outline' },
];

function TabIcon({ lib, name, size, color }) {
  if (lib === 'mci') return <MaterialCommunityIcons name={name} size={size} color={color} />;
  return <Ionicons name={name} size={size} color={color} />;
}

export default function BottomTabBar({ activeTab, onTabPress, theme, isDarkMode, unreadCount }) {
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
                  <TabIcon
                    lib={tab.lib}
                    name={isActive ? tab.icon : tab.iconOutline}
                    size={22}
                    color={isActive ? activeTint : inactiveTint}
                  />
                  {tab.key === 'chats' && unreadCount > 0 && (
                    <View style={[styles.badge, { backgroundColor: activeTint }]}>
                      <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
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
