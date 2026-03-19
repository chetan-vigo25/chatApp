import React, { useRef, useEffect } from "react";
import { View, Text, TouchableOpacity, Animated, Dimensions, StyleSheet, Platform, Image } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";

import ChatList from "../screens/chats/ChatList";
import Setting from "../screens/profiles/Setting";
import Profile from "../screens/profiles/Profile";
import AddUser from "../screens/chats/AddUser";

const Tab = createBottomTabNavigator();
const { width: SCREEN_WIDTH } = Dimensions.get("window");

const TABS = [
  { name: "ChatList", label: "Chats", icon: "chatbubbles-outline", iconFocused: "chatbubbles" },
  { name: "Contacts", label: "Contacts", icon: "people-outline", iconFocused: "people" },
  { name: "Setting", label: "Settings", icon: "settings-outline", iconFocused: "settings" },
  { name: "Profile", label: "Profile", icon: "person-outline", iconFocused: "person" },
];

const TAB_COUNT = TABS.length;
const TAB_BAR_HEIGHT = 60;
const INDICATOR_HEIGHT = 50;

function CustomTabBar({ state, descriptors, navigation }) {
  const { theme, isDarkMode } = useTheme();
  const colors = theme.colors;
  const { profileData, isLoading, error } = useSelector(state => state.profile);

  const tabWidth = SCREEN_WIDTH / TAB_COUNT;
  const indicatorWidth = tabWidth * 0.6;
  const indicatorOffset = (tabWidth - indicatorWidth) / 2;

  const slideAnim = useRef(new Animated.Value(state.index * tabWidth + indicatorOffset)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: state.index * tabWidth + indicatorOffset,
      useNativeDriver: true,
      damping: 18,
      stiffness: 180,
      mass: 0.8,
    }).start();
  }, [state.index]);

  const tabBarBg = isDarkMode ? '#17212B' : colors.background;
  const borderTopColor = isDarkMode ? '#1E2C3A' : '#E0E0E0';
  const indicatorTop = (TAB_BAR_HEIGHT - INDICATOR_HEIGHT) / 2;

 const renderProfileIcon = (focused) => {
  const activeColor = colors.themeColor;
  const inactiveColor = isDarkMode ? '#6D7F8E' : '#9E9E9E';
  const displayName = profileData?.fullName || profileData?.name || '';
  const initial = displayName ? displayName.charAt(0).toUpperCase() : '?';
  
  // Always show the initial letter with colored background
  return (
    <View style={[
      styles.profileImageContainer,
      focused && styles.profileImageContainerFocused,
      { 
        borderColor: focused ? activeColor : 'transparent',
        backgroundColor: profileData?.profileImage ? 'transparent' : colors.themeColor + '30',
      }
    ]}>
      {profileData?.profileImage ? (
        <Image 
          source={{ uri: profileData.profileImage }} 
          style={styles.profileImage} 
        />
      ) : (
        <View style={[
          styles.initialContainer,
          { backgroundColor: colors.themeColor }
        ]}>
          <Text style={styles.initialText}>
            {initial}
          </Text>
        </View>
      )}
    </View>
  );
};

  return (
    <View style={[styles.tabBarContainer, { backgroundColor: tabBarBg, borderTopColor }]}>
      {/* Sliding indicator */}
      <Animated.View
        style={[
          styles.indicator,
          {
            top: indicatorTop,
            width: indicatorWidth,
            height: INDICATOR_HEIGHT,
            borderRadius: INDICATOR_HEIGHT / 2,
            backgroundColor: colors.themeColor + '20',
            transform: [{ translateX: slideAnim }],
          },
        ]}
      />

      {state.routes.map((route, index) => {
        const tab = TABS[index];
        const focused = state.index === index;
        const activeColor = colors.themeColor;
        const inactiveColor = isDarkMode ? '#6D7F8E' : '#9E9E9E';
        const color = focused ? activeColor : inactiveColor;

        return (
          <TouchableOpacity
            key={route.key}
            activeOpacity={0.7}
            onPress={() => {
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            }}
            onLongPress={() => {
              navigation.emit({ type: "tabLongPress", target: route.key });
            }}
            style={styles.tabButton}
          >
            {tab.label === 'Profile' ? (
              renderProfileIcon(focused)
            ) : (
              <Ionicons 
                name={focused ? tab.iconFocused : tab.icon} 
                size={22} 
                color={color} 
              />
            )}
            
            <Text 
              style={[
                styles.tabLabel, 
                {
                  color, 
                  fontFamily: focused ? 'Roboto-Medium' : 'Roboto-Regular',
                }
              ]}
              numberOfLines={1}
            > 
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function BottomTabNavigator() {
  return (
    <Tab.Navigator
      initialRouteName="ChatList"
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="ChatList" component={ChatList} />
      <Tab.Screen name="Contacts" component={AddUser} />
      <Tab.Screen name="Setting" component={Setting} />
      <Tab.Screen name="Profile" component={Profile} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBarContainer: {
    flexDirection: "row",
    height: TAB_BAR_HEIGHT,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  indicator: {
    position: "absolute",
    left: 0,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    height: TAB_BAR_HEIGHT,
  },
  tabLabel: {
    fontSize: 11.5,
    marginTop: 0,
  },
  profileImageContainer: {
    width: 32,
    height: 32,
    borderRadius: 50,
    overflow: 'hidden',
    borderWidth: 2,
    marginBottom: 2,
  },
  profileImageContainerFocused: {
    borderWidth: 2,
  },
  profileImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
 profileImageContainer: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    marginBottom: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileImageContainerFocused: {
    borderWidth: 2,
  },
  profileImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  initialContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 16,
  },
  initialText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontFamily: 'Roboto-Medium',
    includeFontPadding: false,
    textAlign: 'center',
    lineHeight: Platform.OS === 'ios' ? 18 : 20,
  },
});