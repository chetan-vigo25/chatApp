import React from 'react';
import { View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { useNavigation } from '@react-navigation/native';
import ChatList from '../screens/chats/ChatList';
import Profile from '../screens/profiles/Profile';
import AddUser from '../screens/chats/AddUser';
import Setting from '../screens/profiles/Setting';
import StatusList from '../screens/status/StatusList';
import CallsScreen from '../screens/calls/CallsScreen';
import BottomTabBar from '../components/BottomTabBar';
import { useTheme } from '../contexts/ThemeContext';
import { useRealtimeChat } from '../contexts/RealtimeChatContext';

const Tab = createBottomTabNavigator();

// Tab route order — MUST match the <Tab.Screen> registration order below.
// Drives both the custom tab bar (active index) and the swipe-between-tabs
// gesture (navigates to the adjacent route).
const TAB_ROUTES = [
  'ChatListTab', 'StatusTab', 'CallsTab', 'SettingsTab', 'ContactsTab', 'ProfileTab',
];

// WhatsApp-style swipe between tabs. A decisive horizontal swipe moves to the
// previous / next tab; vertical movement fails the gesture so the underlying
// lists keep scrolling, and `activeOffsetX` leaves taps untouched. We run the
// gesture callback on the JS thread (`runOnJS`) so it can call navigation.
function TabSwipe({ index, children }) {
  const navigation = useNavigation();

  const goTo = (delta) => {
    const next = index + delta;
    if (next < 0 || next >= TAB_ROUTES.length) return;
    navigation.navigate(TAB_ROUTES[next]);
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-24, 24])
    .failOffsetY([-18, 18])
    .onEnd((e) => {
      const decisive = Math.abs(e.translationX) > 64 || Math.abs(e.velocityX) > 520;
      if (!decisive) return;
      if (e.translationX < 0) goTo(1);   // swipe left  → next tab
      else goTo(-1);                     // swipe right → previous tab
    });

  return (
    <GestureDetector gesture={pan}>
      <View style={{ flex: 1 }}>{children}</View>
    </GestureDetector>
  );
}

// Wrap each tab screen so it responds to the swipe gesture. Defined once at
// module scope (stable component identity) so screens are not remounted on
// every render of the navigator.
const withSwipe = (ScreenComponent, index) => {
  function SwipeableTabScreen(props) {
    return (
      <TabSwipe index={index}>
        <ScreenComponent {...props} />
      </TabSwipe>
    );
  }
  SwipeableTabScreen.displayName =
    `SwipeableTab(${ScreenComponent.displayName || ScreenComponent.name || 'Screen'})`;
  return SwipeableTabScreen;
};

// Index MUST match each route's position in TAB_ROUTES / the <Tab.Screen>
// order below, so a swipe lands on the correct adjacent tab.
const ChatsTabScreen    = withSwipe(ChatList, 0);
const StatusTabScreen   = withSwipe(StatusList, 1);
const CallsTabScreen    = withSwipe(CallsScreen, 2);
const SettingsTabScreen = withSwipe(Setting, 3);
const ContactsTabScreen = withSwipe(AddUser, 4);
const ProfileTabScreen  = withSwipe(Profile, 5);

function CustomTabBar({ state, navigation }) {
  const { theme, isDarkMode } = useTheme();
  const { state: realtimeState } = useRealtimeChat();

  // Order MUST match the <Tab.Screen> registration order below — `state.index`
  // is the position of the active route in that list.
  const tabKeys = ['chats', 'status', 'calls', 'settings', 'contacts', 'profile'];
  const activeTab = tabKeys[state.index] || 'chats';

  const handleTabPress = (tabKey) => {
    const routeMap = {
      chats: 'ChatListTab',
      status: 'StatusTab',
      settings: 'SettingsTab',
      calls: 'CallsTab',
      contacts: 'ContactsTab',
      profile: 'ProfileTab',
    };
    const routeName = routeMap[tabKey];
    if (!routeName) return;

    const event = navigation.emit({
      type: 'tabPress',
      target: state.routes.find((r) => r.name === routeName)?.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  return (
    <BottomTabBar
      activeTab={activeTab}
      onTabPress={handleTabPress}
      theme={theme}
      isDarkMode={isDarkMode}
      unreadCount={Number(realtimeState?.totalUnread || 0)}
    />
  );
}

export default function BottomTabNavigator() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Tab.Navigator
        tabBar={(props) => <CustomTabBar {...props} />}
        screenOptions={{
          headerShown: false,
          lazy: true,
          // No tab transition. The 'shift' animation raced with detached/frozen
          // screens and could leave a re-focused tab (notably the heavy Calls
          // screen) translated off-screen → intermittent blank that needed a
          // second tap. Swiping/tapping still navigates instantly.
          animation: 'none',
        }}
        detachInactiveScreens
        initialRouteName="ChatListTab"
      >
        <Tab.Screen name="ChatListTab" component={ChatsTabScreen} />
        <Tab.Screen name="StatusTab" component={StatusTabScreen} />
        <Tab.Screen name="CallsTab" component={CallsTabScreen} />
        <Tab.Screen name="SettingsTab" component={SettingsTabScreen} />
        <Tab.Screen name="ContactsTab" component={ContactsTabScreen} />
        <Tab.Screen name="ProfileTab" component={ProfileTabScreen} />
      </Tab.Navigator>
    </GestureHandlerRootView>
  );
}
