import React, { useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  Animated,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TABS = [
  { key: 'chats', label: 'Chats', icon: 'chatbubbles', iconOutline: 'chatbubbles-outline' },
  { key: 'status', label: 'Status', icon: 'ellipse', iconOutline: 'ellipse-outline' },
  { key: 'contacts', label: 'Contacts', icon: 'people', iconOutline: 'people-outline' },
  { key: 'profile', label: 'Profile', icon: 'person', iconOutline: 'person-outline' },
  { key: 'settings', label: 'Settings', icon: 'settings', iconOutline: 'settings-outline' },
];
const TAB_COUNT = TABS.length;
const TAB_WIDTH = SCREEN_WIDTH / TAB_COUNT;

export default function BottomTabBar({ activeTab, onTabPress, theme, isDarkMode, unreadCount }) {
  const indicatorAnim = useRef(new Animated.Value(0)).current;
  const scaleAnims = useRef(TABS.map(() => new Animated.Value(1))).current;
  const iconColorAnims = useRef(TABS.map((_, i) => new Animated.Value(i === 0 ? 1 : 0))).current;

  const activeIndex = TABS.findIndex((t) => t.key === activeTab);

  useEffect(() => {
    // Slide indicator — fast timing instead of heavy spring
    Animated.timing(indicatorAnim, {
      toValue: activeIndex * TAB_WIDTH,
      duration: 150,
      useNativeDriver: true,
    }).start();

    // Animate icon colors
    TABS.forEach((_, i) => {
      Animated.timing(iconColorAnims[i], {
        toValue: i === activeIndex ? 1 : 0,
        duration: 120,
        useNativeDriver: false,
      }).start();
    });
  }, [activeIndex]);

  const handlePress = (tab, index) => {
    // Quick scale tap feedback
    Animated.sequence([
      Animated.timing(scaleAnims[index], {
        toValue: 0.9,
        duration: 50,
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnims[index], {
        toValue: 1,
        duration: 80,
        useNativeDriver: true,
      }),
    ]).start();

    onTabPress(tab.key);
  };

  const barBg = isDarkMode ? '#1A2630' : '#FFFFFF';
  const activeTint = theme.colors.themeColor;
  const inactiveTint = theme.colors.placeHolderTextColor;

  return (
    <View style={[styles.container, { backgroundColor: barBg, borderTopColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
      {/* Animated indicator */}
      <Animated.View
        style={[
          styles.indicator,
          {
            backgroundColor: activeTint,
            transform: [{ translateX: Animated.add(indicatorAnim, (TAB_WIDTH - 40) / 2) }],
          },
        ]}
      />

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
              <View style={styles.iconWrap}>
                <Ionicons
                  name={isActive ? tab.icon : tab.iconOutline}
                  size={22}
                  color={isActive ? activeTint : inactiveTint}
                />
                {tab.key === 'chats' && unreadCount > 0 && (
                  <View style={[styles.badge, { backgroundColor: activeTint }]}>
                    <Text style={styles.badgeText}>
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </Text>
                  </View>
                )}
              </View>
              <Text
                style={[
                  styles.label,
                  {
                    color: isActive ? activeTint : inactiveTint,
                    fontFamily: isActive ? 'Roboto-SemiBold' : 'Roboto-Regular',
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
    height: Platform.OS === 'ios' ? 82 : 64,
    paddingBottom: Platform.OS === 'ios' ? 18 : 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
  },
  indicator: {
    position: 'absolute',
    top: 0,
    width: 40,
    height: 3,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 6,
  },
  iconWrap: {
    position: 'relative',
    marginBottom: 2,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
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
    fontSize: 10.5,
    marginTop: 1,
  },
});